import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const APP_BUNDLE_ID = "com.openai.chat";
const APP_NAME = "ChatGPT";
const APP_PROCESS_NAME = "ChatGPT";
const APP_SURFACE = "psst-gpt";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_WAIT_CHUNK_MS = 90000;
const POLL_INTERVAL_MS = 2000;
const RESPONSE_STABLE_MS = 8000;
const JXA_TIMEOUT_MS = 30000;
const DEFAULT_BACKGROUND = true;

export async function runPsstGPT(options = {}) {
  return relayPromptToChatGPTApp(options);
}

export async function startPsstGPT(options = {}) {
  return relayPromptToChatGPTApp({
    ...options,
    returnPending: true,
    returnAfterSend: options.returnAfterSend ?? true,
    timeoutMs: options.timeoutMs ?? DEFAULT_WAIT_CHUNK_MS,
  });
}

export async function continuePsstGPT(options = {}) {
  return relayPromptToChatGPTApp({
    ...options,
    newChat: false,
  });
}

export async function pollPsstGPT(options = {}) {
  const {
    sessionId,
    query,
    statePath,
    timeoutMs = DEFAULT_WAIT_CHUNK_MS,
    returnPending = true,
    background = DEFAULT_BACKGROUND,
  } = options;
  assertStrictBackgroundOptions(options);
  const session = await findStoredAppSession({ sessionId, query, statePath });

  if (!session) {
    throw codedError(
      "PSST_GPT_SESSION_NOT_FOUND",
      "No stored PsstGPT session matched the request."
    );
  }

  await ensureChatGPTAppReady({ background, verify: false });
  const currentState = await readPsstGPTState({ background });
  if (!transcriptContainsPrompt(currentState, session.prompt)) {
    throw codedError(
      "PSST_GPT_SESSION_NOT_ACTIVE",
      "The stored PsstGPT session is not visible in the active ChatGPT app window. PsstGPT cannot reopen prior conversations by URL.",
      { session: publicAppSession(session) }
    );
  }

  const result = await waitForAppAssistantResponse({
    prompt: session.prompt,
    timeoutMs,
    allowPending: returnPending,
    background,
  });
  const messages = messagesForAppRelay(session.prompt, result.assistantText, session.messages);
  const record = await upsertAppSessionRecord({
    statePath,
    relaySessionId: session.relaySessionId,
    prompt: session.prompt,
    title: result.state.title,
    mode: result.state.visibleModelLabel || session.mode,
    background,
    status: result.status,
    messages,
    tags: session.tags ?? [],
  });

  return appRelayResult({
    status: result.status,
    assistantText: result.assistantText,
    state: result.state,
    record,
  });
}

export async function listPsstGPTSessions(options = {}) {
  const { query = "", limit = 20, statePath } = options;
  const store = await loadAppSessionStore(statePath);
  return filterAppSessions(store.sessions, query)
    .slice(0, limit)
    .map((session) => publicAppSession(session));
}

export async function getPsstGPTSession(options = {}) {
  const session = await findStoredAppSession(options);
  return session ? publicAppSession(session) : null;
}

export async function readPsstGPTState(options = {}) {
  assertStrictBackgroundOptions(options);
  const background = options.background ?? DEFAULT_BACKGROUND;
  if (options.ensure !== false) {
    await ensureChatGPTAppReady({ background });
  }
  return runJxa("snapshot", { background });
}

async function relayPromptToChatGPTApp(options = {}) {
  const {
    prompt,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    waitChunkMs = DEFAULT_WAIT_CHUNK_MS,
    returnPending = false,
    statePath,
    newChat = true,
    tags = [],
    relaySessionId,
    background = DEFAULT_BACKGROUND,
    returnAfterSend = false,
  } = options;

  if (typeof prompt !== "string" || !prompt.trim()) {
    throw codedError("PROMPT_MISSING", "A non-empty prompt is required.");
  }

  assertSupportedAppRelayOptions(options);
  await ensureChatGPTAppReady({ background, verify: false });

  const promptText = prompt.trim();
  const initialState = await runJxa("sendPrompt", {
    prompt: promptText,
    newChat: newChat !== false,
    background,
  });
  assertNoFatalAppBlocker(initialState);

  const pendingRecord = await upsertAppSessionRecord({
    statePath,
    relaySessionId,
    prompt: promptText,
    title: initialState.title,
    mode: initialState.visibleModelLabel,
    background,
    status: "pending",
    messages: messagesForAppRelay(promptText, ""),
    tags,
  });

  if (returnAfterSend) {
    return appRelayResult({
      status: "pending",
      assistantText: "",
      state: initialState,
      record: pendingRecord,
    });
  }

  const result = await waitForAppAssistantResponseInChunks({
    prompt: promptText,
    timeoutMs,
    waitChunkMs,
    allowPending: returnPending,
    background,
    onPending: async (pendingResult) => {
      await upsertAppSessionRecord({
        statePath,
        relaySessionId: pendingRecord.relaySessionId,
        prompt: promptText,
        title: pendingResult.state.title,
        mode: pendingResult.state.visibleModelLabel || pendingRecord.mode,
        background,
        status: pendingResult.status,
        messages: messagesForAppRelay(promptText, pendingResult.assistantText),
        tags,
      });
    },
  });
  const messages = messagesForAppRelay(promptText, result.assistantText);
  const record = await upsertAppSessionRecord({
    statePath,
    relaySessionId: pendingRecord.relaySessionId,
    prompt: promptText,
    title: result.state.title,
    mode: result.state.visibleModelLabel || pendingRecord.mode,
    background,
    status: result.status,
    messages,
    tags,
  });

  return appRelayResult({
    status: result.status,
    assistantText: result.assistantText,
    state: result.state,
    record,
  });
}

function assertSupportedAppRelayOptions(options = {}) {
  const unsupported = [];
  if ((options.filePaths ?? []).length > 0 || (options.attachments ?? []).length > 0) {
    unsupported.push("attachments");
  }
  if (options.feature) unsupported.push("feature");
  if (options.projectName) unsupported.push("projectName");
  if (options.appName) unsupported.push("appName");
  if (options.conversationUrl) unsupported.push("conversationUrl");
  if (options.background === false) unsupported.push("foreground mode");
  if (options.allowWindowRecovery === true) unsupported.push("window recovery");
  if (hasExplicitIntelligenceOption(options)) {
    unsupported.push("model/mode/effort selection");
  }

  if (unsupported.length > 0) {
    throw codedError(
      "PSST_GPT_UNSUPPORTED_OPTION",
      `PsstGPT supports verified text prompt relay through the active ChatGPT app only. Unsupported option(s): ${unsupported.join(", ")}.`,
      { unsupported }
    );
  }
}

function assertStrictBackgroundOptions(options = {}) {
  if (options.background === false) {
    throw codedError(
      "PSST_GPT_FOREGROUND_DISABLED",
      "PsstGPT is strict-background only. It will not activate ChatGPT or steal focus."
    );
  }
  if (options.allowWindowRecovery === true) {
    throw codedError(
      "PSST_GPT_WINDOW_RECOVERY_DISABLED",
      "PsstGPT will not open or recover ChatGPT windows because that can interrupt other work. Open a ChatGPT app window manually before starting background relay."
    );
  }
}

function hasExplicitIntelligenceOption(options = {}) {
  return [
    options.model,
    options.mode,
    options.intelligenceMode,
    options.reasoningMode,
    options.thinkingMode,
    options.reasoningEffort,
    options.thinkingEffort,
    options.proEffort,
    options.effort,
  ].some((value) => value !== undefined && value !== null && String(value).trim());
}

async function ensureChatGPTAppReady({ background = DEFAULT_BACKGROUND, verify = true } = {}) {
  if (process.platform !== "darwin") {
    throw codedError(
      "PSST_GPT_UNSUPPORTED_PLATFORM",
      "PsstGPT currently supports macOS only."
    );
  }

  await assertChatGPTAppInstalled();

  try {
    await execFileAsync("/usr/bin/open", ["-g", "-b", APP_BUNDLE_ID], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    throw codedError(
      "PSST_GPT_LAUNCH_FAILED",
      "Could not launch the ChatGPT desktop app.",
      { cause: error }
    );
  }

  if (verify) {
    await runJxa("waitReady", { background });
  }
}

async function assertChatGPTAppInstalled() {
  const candidatePaths = [
    "/Applications/ChatGPT.app",
    path.join(os.homedir(), "Applications", "ChatGPT.app"),
  ];

  for (const candidate of candidatePaths) {
    try {
      await access(candidate);
      return;
    } catch {
      // Try the next standard install location.
    }
  }

  throw codedError(
    "PSST_GPT_NOT_INSTALLED",
    "Could not find ChatGPT.app in /Applications or ~/Applications. Install it from https://chatgpt.com/download/."
  );
}

async function waitForAppAssistantResponseInChunks({
  prompt,
  timeoutMs,
  waitChunkMs,
  allowPending,
  background,
  onPending,
}) {
  const started = Date.now();
  let lastPending = null;

  while (Date.now() - started < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - started);
    const chunkMs = Math.max(1, Math.min(waitChunkMs ?? DEFAULT_WAIT_CHUNK_MS, remainingMs));
    const result = await waitForAppAssistantResponse({
      prompt,
      timeoutMs: chunkMs,
      allowPending: true,
      background,
    });

    if (result.status === "complete") {
      return result;
    }

    lastPending = result;
    await onPending?.(result);

    if (allowPending) {
      return result;
    }
  }

  if (allowPending && lastPending) {
    return lastPending;
  }

  throw codedError(
    "PSST_GPT_RESPONSE_TIMEOUT",
    "ChatGPT app did not finish answering before the timeout.",
    { lastState: lastPending?.state ?? null }
  );
}

async function waitForAppAssistantResponse({
  prompt,
  timeoutMs,
  allowPending,
  background,
}) {
  const start = Date.now();
  let lastState = null;
  let lastAssistantText = "";
  let lastChangedAt = Date.now();

  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_INTERVAL_MS);
    const state = await readPsstGPTState({
      background,
      ensure: false,
    });
    assertNoFatalAppBlocker(state);
    lastState = state;

    const assistantText = extractAssistantTextFromAppState(state, prompt);
    if (assistantText !== lastAssistantText) {
      lastAssistantText = assistantText;
      lastChangedAt = Date.now();
    }

    if (isAppResponseCompleteSnapshot({
      assistantText: lastAssistantText,
      textStableForMs: Date.now() - lastChangedAt,
      isAnswering: state.isAnswering,
    })) {
      return {
        status: "complete",
        assistantText: lastAssistantText,
        state,
      };
    }
  }

  if (allowPending) {
    return {
      status: "pending",
      assistantText: lastAssistantText,
      state: lastState,
    };
  }

  throw codedError(
    "PSST_GPT_RESPONSE_TIMEOUT",
    "ChatGPT app did not finish answering before the timeout.",
    { lastState }
  );
}

function isAppResponseCompleteSnapshot({ assistantText, textStableForMs, isAnswering }) {
  return Boolean(
    assistantText?.trim() &&
    !isAppTransientText(assistantText) &&
    textStableForMs >= RESPONSE_STABLE_MS &&
    !isAnswering
  );
}

function extractAssistantTextFromAppState(state = {}, prompt = "") {
  const promptNeedle = normalizeForMatch(prompt);
  const transcript = Array.isArray(state.transcriptTexts)
    ? state.transcriptTexts
    : [];
  let promptIndex = -1;

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const text = normalizeForMatch(transcript[index]?.text ?? transcript[index]);
    if (!text) {
      continue;
    }
    if (
      text === promptNeedle ||
      (promptNeedle.length >= 80 && text.includes(promptNeedle.slice(0, 80))) ||
      (text.length >= 80 && promptNeedle.includes(text.slice(0, 80)))
    ) {
      promptIndex = index;
      break;
    }
  }

  const candidates = (promptIndex >= 0 ? transcript.slice(promptIndex + 1) : transcript)
    .map((entry) => String(entry?.text ?? entry ?? "").trim())
    .filter(Boolean)
    .filter((text) => !isAppUiText(text))
    .filter((text) => normalizeForMatch(text) !== promptNeedle)
    .filter((text) => !isAppTransientText(text));

  return normalizeAssistantText(dedupeAdjacent(candidates).join("\n"));
}

function transcriptContainsPrompt(state = {}, prompt = "") {
  const promptNeedle = normalizeForMatch(prompt);
  return (state.transcriptTexts ?? []).some((entry) => {
    const text = normalizeForMatch(entry?.text ?? entry);
    return text === promptNeedle ||
      (promptNeedle.length >= 80 && text.includes(promptNeedle.slice(0, 80)));
  });
}

function isAppUiText(text = "") {
  const normalized = normalizeWhitespace(text)
    .replace(/\u2019/g, "'")
    .replace(/\u2018/g, "'");
  return (
    normalized === "Ask anything" ||
    normalized === "Turn on notifications" ||
    normalized === "Get notified when there's an update on your tasks." ||
    normalized === "Get notified when there is an update on your tasks." ||
    /^ChatGPT can make mistakes/i.test(normalized) ||
    /^Message ChatGPT/i.test(normalized)
  );
}

function isAppTransientText(text = "") {
  const normalized = normalizeWhitespace(text);
  return (
    normalized === "Thinking" ||
    normalized === "Pro thinking" ||
    normalized === "Searching" ||
    normalized === "Searching the web" ||
    /^Thought for \d+s$/i.test(normalized) ||
    /^Analyzing images?$/i.test(normalized) ||
    /^Processing images?$/i.test(normalized) ||
    /^Reading images?$/i.test(normalized)
  );
}

function assertNoFatalAppBlocker(state = {}) {
  const text = normalizeWhitespace((state.visibleText ?? "").replace(/\n/g, " "));
  if (/\b(log in|sign up|sign in)\b/i.test(text)) {
    throw codedError(
      "PSST_GPT_LOGIN_REQUIRED",
      "The ChatGPT desktop app is showing a login or sign-up prompt."
    );
  }
  if (/\b(captcha|verify you are human|verification required)\b/i.test(text)) {
    throw codedError(
      "PSST_GPT_VERIFICATION_REQUIRED",
      "The ChatGPT desktop app is showing a verification or CAPTCHA prompt."
    );
  }
}

function appRelayResult({ status, assistantText, state, record }) {
  const finalDeliveryText = formatAppFinalDeliveryText({
    assistantText,
    relaySessionId: record.relaySessionId,
  });
  const mustReturnFinalDelivery = status === "complete" && finalDeliveryText.trim().length > 0;

  return {
    ok: true,
    status,
    surface: APP_SURFACE,
    appBundleId: APP_BUNDLE_ID,
    mode: record.mode || state.visibleModelLabel || "Current ChatGPT app selection",
    background: record.background ?? state.background ?? true,
    frontmostProcessName: state.frontmostProcessName,
    assistantText,
    finalDeliveryText,
    finalResponseText: finalDeliveryText,
    mustReturnFinalDelivery,
    finalDeliveryField: "finalDeliveryText",
    mustReturnVerbatim: mustReturnFinalDelivery,
    verbatimField: "finalDeliveryText",
    finalOutputContract: {
      kind: "complete-psst-gpt-delivery",
      appliesWhen: 'status is "complete" and finalDeliveryText is non-empty',
      instruction:
        "Return finalDeliveryText exactly as the final user-facing answer. Do not summarize, rewrite, omit, add a preface, or wrap it in another format.",
    },
    session: publicAppSession(record),
    appState: {
      title: state.title,
      visibleModelLabel: state.visibleModelLabel,
      frontmostProcessName: state.frontmostProcessName,
    },
  };
}

function formatAppFinalDeliveryText({ assistantText = "", relaySessionId = "" } = {}) {
  const text = String(assistantText ?? "").trimEnd();
  const sessionLine = relaySessionId
    ? `PsstGPT session: ${relaySessionId}`
    : "PsstGPT session:";
  return text ? `${text}\n\n${sessionLine}` : sessionLine;
}

function messagesForAppRelay(prompt, assistantText, previousMessages = []) {
  const messages = Array.isArray(previousMessages) && previousMessages.length
    ? previousMessages.map((message, index) => ({ ...message, index }))
    : [
        {
          index: 0,
          role: "user",
          text: String(prompt ?? "").trim(),
        },
      ];

  if (assistantText?.trim()) {
    const existingAssistantIndex = messages.findIndex(
      (message) => message.role === "assistant" && message.text === assistantText.trim()
    );
    if (existingAssistantIndex === -1) {
      messages.push({
        index: messages.length,
        role: "assistant",
        text: assistantText.trim(),
      });
    }
  }
  return messages.map((message, index) => ({ ...message, index }));
}

async function runJxa(action, payload = {}, { timeoutMs = JXA_TIMEOUT_MS } = {}) {
  const request = JSON.stringify({ action, payload });
  let stdout;
  let stderr;

  try {
    ({ stdout, stderr } = await execFileAsync(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", PSST_GPT_JXA, request],
      {
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
      }
    ));
  } catch (error) {
    throw codedError(
      "PSST_GPT_AUTOMATION_FAILED",
      "ChatGPT app automation failed while running osascript.",
      { cause: error }
    );
  }

  const raw = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw codedError(
      "PSST_GPT_BRIDGE_INVALID_RESPONSE",
      "ChatGPT app automation returned an invalid response.",
      { stdout, stderr, cause: error }
    );
  }

  if (!parsed.ok) {
    throw codedError(
      parsed.code || "PSST_GPT_AUTOMATION_FAILED",
      parsed.message || "ChatGPT app automation failed.",
      { details: parsed.details, stderr }
    );
  }

  return parsed.value;
}

const PSST_GPT_JXA = String.raw`
function run(argv) {
  try {
    var request = JSON.parse(argv[0] || "{}");
    var value = dispatch(request.action, request.payload || {});
    return JSON.stringify({ ok: true, value: value });
  } catch (error) {
    return JSON.stringify({
      ok: false,
      code: error.code || "PSST_GPT_AUTOMATION_FAILED",
      message: String(error.message || error),
      details: error.details || null
    });
  }
}

function dispatch(action, payload) {
  if (action === "waitReady") {
    return withChatGPTApp({ background: payload.background !== false }, function(context) {
      waitForComposer(context.window, 15000);
      return readState(context);
    });
  }
  if (action === "snapshot") {
    return withChatGPTApp({ background: payload.background !== false }, function(context) {
      return readState(context);
    });
  }
  if (action === "sendPrompt") {
    return withChatGPTApp({ background: payload.background !== false }, function(context) {
      if (payload.newChat !== false) {
        clickNewChat(context.window);
        delay(0.5);
      }
      var composer = waitForComposer(context.window, 15000);
      composer.value = String(payload.prompt || "");
      delay(0.1);
      var actual = String(composer.value() || "");
      if (actual.trim() !== String(payload.prompt || "").trim()) {
        fail("PSST_GPT_PROMPT_NOT_SET", "Could not set the ChatGPT app composer text through Accessibility.", {
          actualLength: actual.length,
          promptLength: String(payload.prompt || "").length
        });
      }
      sendComposerPrompt(context.window, composer);
      return waitForPromptAccepted(context, composer, String(payload.prompt || ""), 5000);
    });
  }
  fail("PSST_GPT_BRIDGE_UNKNOWN_ACTION", "Unknown ChatGPT app bridge action: " + action);
}

function withChatGPTApp(options, callback) {
  var systemEvents = Application("System Events");
  if (!systemEvents.uiElementsEnabled()) {
    fail("MACOS_ACCESSIBILITY_DISABLED", "macOS Accessibility automation is not enabled for the current process.");
  }
  var frontmostBefore = frontmostProcessName(systemEvents);

  var chatgpt = Application("ChatGPT");
  var bundleId = "";
  try {
    bundleId = chatgpt.id();
  } catch (error) {
    fail("PSST_GPT_NOT_INSTALLED", "The ChatGPT desktop app is not installed or is not registered with LaunchServices.");
  }
  if (bundleId !== "com.openai.chat") {
    fail("PSST_GPT_BUNDLE_MISMATCH", "The application named ChatGPT did not resolve to bundle id com.openai.chat.", {
      bundleId: bundleId
    });
  }

  var process = systemEvents.processes.byName("ChatGPT");
  var deadline = Date.now() + 15000;
  while ((!process.exists() || process.windows.length === 0) && Date.now() < deadline) {
    delay(0.25);
    process = systemEvents.processes.byName("ChatGPT");
  }
  if (!process.exists() || process.windows.length === 0) {
    fail("PSST_GPT_WINDOW_MISSING_BACKGROUND", "No ChatGPT app window is available. Strict background mode will not open, recover, or foreground a ChatGPT window. Open a ChatGPT app window manually, then rerun the relay.");
  }

  var window = process.windows[0];
  var context = {
    systemEvents: systemEvents,
    chatgpt: chatgpt,
    process: process,
    window: window,
    background: options.background !== false,
    frontmostBefore: frontmostBefore
  };

  try {
    var result = callback(context);
    if (context.background) {
      restoreFrontmostProcess(systemEvents, frontmostBefore);
      if (result && typeof result === "object" && !Array.isArray(result)) {
        result.frontmostProcessName = frontmostProcessName(systemEvents);
        result.frontmostBefore = frontmostBefore;
      }
    }
    return result;
  } catch (error) {
    if (context.background) {
      restoreFrontmostProcess(systemEvents, frontmostBefore);
    }
    throw error;
  }
}

function readState(context) {
  var nodes = descendants(context.window);
  var composer = firstNode(nodes, function(node) {
    return safeString(function() { return node.role(); }) === "AXTextArea";
  });
  var composerRecord = composer ? recordForNode(composer, -1) : null;
  var composerTop = composerRecord && composerRecord.position
    ? composerRecord.position.y
    : Number.POSITIVE_INFINITY;

  var staticTexts = [];
  for (var index = 0; index < nodes.length; index += 1) {
    var node = nodes[index];
    if (safeString(function() { return node.role(); }) !== "AXStaticText") {
      continue;
    }
    var record = recordForNode(node, index);
    var text = staticTextForRecord(record);
    if (!text) {
      continue;
    }
    if (record.position && record.position.y >= composerTop - 8) {
      continue;
    }
    staticTexts.push({
      text: text,
      position: record.position,
      size: record.size
    });
  }

  staticTexts.sort(function(a, b) {
    var ay = a.position ? a.position.y : 0;
    var by = b.position ? b.position.y : 0;
    var ax = a.position ? a.position.x : 0;
    var bx = b.position ? b.position.x : 0;
    return ay - by || ax - bx;
  });

  var buttons = [];
  for (var buttonIndex = 0; buttonIndex < nodes.length; buttonIndex += 1) {
    var buttonNode = nodes[buttonIndex];
    if (safeString(function() { return buttonNode.role(); }) !== "AXButton") {
      continue;
    }
    buttons.push(recordForNode(buttonNode, buttonIndex));
  }

  var buttonLabels = buttons.map(function(button) {
    return normalizeText([button.name, button.description, button.value].filter(Boolean).join(" "));
  }).filter(Boolean);
  var transcriptTexts = staticTexts.map(function(entry) { return entry.text; });
  var visibleText = transcriptTexts.join("\n");
  var visibleModelLabel = findVisibleModelLabel(buttons);
  var isAnswering = buttonLabels.some(function(label) {
    return /\b(stop|cancel)\b/i.test(label) && /\b(generating|answer|response|stream|thinking)\b/i.test(label);
  });

  return {
    title: safeString(function() { return context.window.name(); }) || "ChatGPT",
    bundleId: "com.openai.chat",
    processName: "ChatGPT",
    frontmostProcessName: frontmostProcessName(context.systemEvents),
    frontmostBefore: context.frontmostBefore,
    background: context.background,
    hasComposer: Boolean(composer),
    composerValue: composer ? safeString(function() { return composer.value(); }) : "",
    visibleModelLabel: visibleModelLabel,
    transcriptTexts: transcriptTexts,
    visibleText: visibleText,
    buttonLabels: buttonLabels,
    isAnswering: isAnswering
  };
}

function readMinimalState(context, composer) {
  var buttons = toolbarButtons(context.window).map(function(button, index) {
    return recordForNode(button, index);
  });
  var buttonLabels = buttons.map(function(button) {
    return buttonLabel(button);
  }).filter(Boolean);

  return {
    title: safeString(function() { return context.window.name(); }) || "ChatGPT",
    bundleId: "com.openai.chat",
    processName: "ChatGPT",
    frontmostProcessName: frontmostProcessName(context.systemEvents),
    frontmostBefore: context.frontmostBefore,
    background: context.background,
    hasComposer: Boolean(composer),
    composerValue: composer ? safeString(function() { return composer.value(); }) : "",
    visibleModelLabel: findVisibleModelLabel(buttons),
    transcriptTexts: [],
    visibleText: "",
    buttonLabels: buttonLabels,
    isAnswering: false,
    minimal: true
  };
}

function clickNewChat(window) {
  var buttons = toolbarButtons(window);

  if (buttons.length === 0) {
    buttons = descendants(window).filter(function(node) {
      return safeString(function() { return node.role(); }) === "AXButton";
    });
  }

  for (var buttonIndex = 0; buttonIndex < buttons.length; buttonIndex += 1) {
    var button = buttons[buttonIndex];
    var label = normalizeText([
      safeString(function() { return button.description(); }),
      safeString(function() { return button.name(); }),
      safeString(function() { return button.value(); })
    ].join(" "));
    if (/^New chat$/i.test(label)) {
      pressElement(button);
      return;
    }
  }

  fail("PSST_GPT_NEW_CHAT_MISSING", "Could not find the ChatGPT app New chat button.");
}

function toolbarButtons(window) {
  var buttons = [];
  try {
    var toolbars = window.toolbars();
    for (var toolbarIndex = 0; toolbarIndex < toolbars.length; toolbarIndex += 1) {
      var toolbarButtonList = toolbars[toolbarIndex].buttons();
      for (var index = 0; index < toolbarButtonList.length; index += 1) {
        buttons.push(toolbarButtonList[index]);
      }
    }
  } catch (error) {
    buttons = [];
  }
  return buttons;
}

function sendComposerPrompt(window, composer) {
  var nodes = descendants(window);
  var sendButton = findSendButton(nodes, composer);
  if (!sendButton) {
    fail("PSST_GPT_SEND_BUTTON_MISSING", "Could not find the ChatGPT app send button after setting the composer text.");
  }

  pressElement(sendButton);
  delay(0.4);
}

function waitForPromptAccepted(context, composer, promptText, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    var composerValue = safeString(function() { return composer.value(); });
    if (normalizeText(composerValue) !== normalizeText(promptText)) {
      return readMinimalState(context, composer);
    }
    delay(0.25);
  }

  fail("PSST_GPT_SEND_NOT_CONFIRMED", "The ChatGPT app composer still contained the prompt after pressing Send.", {
    composerValueLength: String(safeString(function() { return composer.value(); }) || "").length,
    promptLength: String(promptText || "").length
  });
}

function findSendButton(nodes, composer) {
  var composerRecord = recordForNode(composer, -1);
  var candidates = [];
  for (var index = 0; index < nodes.length; index += 1) {
    var node = nodes[index];
    if (safeString(function() { return node.role(); }) !== "AXButton") {
      continue;
    }
    var record = recordForNode(node, index);
    if (record.enabled === "false" || !record.position || !record.size) {
      continue;
    }
    if (!isPossibleSendButton(record, composerRecord)) {
      continue;
    }
    candidates.push({
      node: node,
      record: record,
      score: sendButtonScore(record, composerRecord)
    });
  }
  candidates.sort(function(a, b) {
    return b.score - a.score || b.record.position.x - a.record.position.x;
  });
  return candidates.length > 0 ? candidates[0].node : null;
}

function isPossibleSendButton(button, composer) {
  if (!composer.position || !composer.size || !button.position || !button.size) {
    return false;
  }
  var label = buttonLabel(button);
  if (/ChatGPT|New chat|Share|Move|Sidebar|close|minimize|full screen|5\.\d|4\.5|o3|Pro|Thinking|Instant/i.test(label)) {
    return false;
  }
  var buttonCenterY = button.position.y + button.size.height / 2;
  var composerCenterY = composer.position.y + composer.size.height / 2;
  var nearComposerRow = Math.abs(buttonCenterY - composerCenterY) <= 80;
  var rightOfComposer = button.position.x > composer.position.x + Math.max(180, composer.size.width * 0.35);
  var reasonableSize =
    button.size.width >= 16 &&
    button.size.width <= 80 &&
    button.size.height >= 16 &&
    button.size.height <= 80;
  return nearComposerRow && rightOfComposer && reasonableSize;
}

function sendButtonScore(button, composer) {
  var rightness = button.position.x;
  var verticalPenalty = Math.abs(
    (button.position.y + button.size.height / 2) -
    (composer.position.y + composer.size.height / 2)
  );
  return rightness - verticalPenalty * 4;
}

function pressElement(element) {
  try {
    element.actions.byName("AXPress").perform();
    return;
  } catch (error) {
    fail("PSST_GPT_AXPRESS_UNAVAILABLE", "A required ChatGPT app control did not expose the AXPress accessibility action.");
  }
}

function waitForComposer(window, timeoutMs) {
  var deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    var nodes = descendants(window);
    var composer = firstNode(nodes, function(node) {
      return safeString(function() { return node.role(); }) === "AXTextArea";
    });
    if (composer) {
      return composer;
    }
    delay(0.25);
  }
  fail("PSST_GPT_COMPOSER_MISSING", "Could not find the ChatGPT app composer text area.");
}

function descendants(root) {
  var output = [];
  var stack = [root];
  while (stack.length > 0 && output.length < 4000) {
    var current = stack.pop();
    var children = [];
    try {
      children = current.uiElements();
    } catch (error) {
      children = [];
    }
    for (var index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
    for (var outIndex = 0; outIndex < children.length; outIndex += 1) {
      output.push(children[outIndex]);
    }
  }
  return output;
}

function firstNode(nodes, predicate) {
  for (var index = 0; index < nodes.length; index += 1) {
    if (predicate(nodes[index])) {
      return nodes[index];
    }
  }
  return null;
}

function recordForNode(node, index) {
  return {
    index: index,
    role: safeString(function() { return node.role(); }),
    subrole: safeString(function() { return node.subrole(); }),
    name: safeString(function() { return node.name(); }),
    description: safeString(function() { return node.description(); }),
    value: safeString(function() { return node.value(); }),
    enabled: safeString(function() { return node.enabled(); }),
    position: pointFromArray(safeArray(function() { return node.position(); })),
    size: sizeFromArray(safeArray(function() { return node.size(); }))
  };
}

function buttonLabel(record) {
  return normalizeText([record.description, record.name, record.value].filter(Boolean).join(" "));
}

function staticTextForRecord(record) {
  var description = normalizeText(record.description);
  var value = normalizeText(record.value);
  var name = normalizeText(record.name);
  if (description && description.toLowerCase() !== "text") {
    return description;
  }
  return value || name || "";
}

function findVisibleModelLabel(buttons) {
  for (var index = 0; index < buttons.length; index += 1) {
    var button = buttons[index];
    var candidates = [button.value, button.description, button.name]
      .map(normalizeText)
      .filter(Boolean);
    for (var candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      var label = candidates[candidateIndex].replace(/\u2006/g, " ");
      if (/^(?:ChatGPT\s*)?(?:5\.\d|4\.5|o3).*/i.test(label) || /\b(Instant|Thinking|Pro)\b/i.test(label)) {
        return label.replace(/^ChatGPT\s*/i, "").trim();
      }
    }
  }
  return "";
}

function frontmostProcessName(systemEvents) {
  try {
    var frontmost = systemEvents.processes.whose({ frontmost: true })();
    if (frontmost.length > 0) {
      return safeString(function() { return frontmost[0].name(); });
    }
  } catch (error) {
    return "";
  }
  return "";
}

function restoreFrontmostProcess(systemEvents, processName) {
  if (!processName || processName === "ChatGPT") {
    return;
  }
  if (frontmostProcessName(systemEvents) !== "ChatGPT") {
    return;
  }
  try {
    systemEvents.processes.byName(processName).frontmost = true;
    delay(0.2);
  } catch (error) {
    // Best-effort focus restoration only; relay correctness does not depend on it.
  }
}

function transcriptContainsText(transcriptTexts, targetText) {
  var target = normalizeText(targetText).toLowerCase();
  if (!target) {
    return false;
  }
  for (var index = 0; index < transcriptTexts.length; index += 1) {
    var candidate = normalizeText(transcriptTexts[index]).toLowerCase();
    if (
      candidate === target ||
      (target.length >= 80 && candidate.indexOf(target.slice(0, 80)) !== -1) ||
      (candidate.length >= 80 && target.indexOf(candidate.slice(0, 80)) !== -1)
    ) {
      return true;
    }
  }
  return false;
}

function pointFromArray(value) {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  return {
    x: Number(value[0]),
    y: Number(value[1])
  };
}

function sizeFromArray(value) {
  if (!Array.isArray(value) || value.length < 2) {
    return null;
  }
  return {
    width: Number(value[0]),
    height: Number(value[1])
  };
}

function safeArray(callback) {
  try {
    var value = callback();
    return Array.isArray(value) ? value : [];
  } catch (error) {
    return [];
  }
}

function safeString(callback) {
  try {
    var value = callback();
    if (value === null || value === undefined) {
      return "";
    }
    return String(value);
  } catch (error) {
    return "";
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function fail(code, message, details) {
  var error = new Error(message);
  error.code = code;
  error.details = details || null;
  throw error;
}
`;

function normalizeAssistantText(text = "") {
  return String(text ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeWhitespace(value = "") {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function normalizeForMatch(value = "") {
  return normalizeWhitespace(value).toLowerCase();
}

function dedupeAdjacent(values = []) {
  const output = [];
  for (const value of values) {
    if (output.at(-1) !== value) {
      output.push(value);
    }
  }
  return output;
}

async function upsertAppSessionRecord(input) {
  const statePath = getAppStatePath(input.statePath);
  const store = await loadAppSessionStore(statePath);
  const now = new Date().toISOString();
  const relaySessionId = input.relaySessionId || `app-${Date.now()}`;
  const existingIndex = store.sessions.findIndex(
    (session) => session.relaySessionId === relaySessionId
  );
  const existing = existingIndex >= 0 ? store.sessions[existingIndex] : {};
  const messages = input.messages?.length ? input.messages : existing.messages ?? [];
  const next = {
    ...existing,
    relaySessionId,
    surface: APP_SURFACE,
    title: input.title ?? existing.title ?? "ChatGPT",
    prompt: input.prompt ?? existing.prompt ?? messages.find((message) => message.role === "user")?.text ?? "",
    mode: input.mode ?? existing.mode ?? "Current ChatGPT app selection",
    background: input.background ?? existing.background ?? true,
    status: input.status ?? existing.status ?? "complete",
    messages,
    summary: summarizeMessages(messages),
    keywords: extractKeywords(messages),
    tags: dedupe([...(existing.tags ?? []), ...(input.tags ?? [])]),
    statePath,
    createdAt: existing.createdAt ?? now,
    updatedAt: now,
  };

  if (existingIndex >= 0) {
    store.sessions[existingIndex] = next;
  } else {
    store.sessions.push(next);
  }

  await saveAppSessionStore(statePath, store);
  return next;
}

async function findStoredAppSession({ sessionId, query, statePath }) {
  const store = await loadAppSessionStore(statePath);
  const matches = filterAppSessions(store.sessions, query);
  if (!sessionId) {
    return matches[0] ?? null;
  }

  const needle = sessionId.toLowerCase();
  return matches.find((session) =>
    [
      session.relaySessionId,
      session.title,
      session.summary,
      session.prompt,
      ...(session.keywords ?? []),
      ...(session.tags ?? []),
    ]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  ) ?? null;
}

function filterAppSessions(sessions = [], query = "") {
  const needle = query.trim().toLowerCase();
  const sorted = [...sessions].sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
  );
  if (!needle) {
    return sorted;
  }
  return sorted.filter((session) =>
    [
      session.relaySessionId,
      session.title,
      session.summary,
      session.prompt,
      ...(session.keywords ?? []),
      ...(session.tags ?? []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle)
  );
}

async function loadAppSessionStore(statePath) {
  const resolvedPath = getAppStatePath(statePath);
  try {
    const raw = await readFile(resolvedPath, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.sessions)) {
      return parsed;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw codedError(
        "PSST_GPT_SESSION_STORE_READ_FAILED",
        "Could not read PsstGPT session store.",
        { cause: error }
      );
    }
  }

  return {
    version: 1,
    surface: APP_SURFACE,
    sessions: [],
  };
}

async function saveAppSessionStore(statePath, store) {
  const resolvedPath = getAppStatePath(statePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function getAppStatePath(statePath) {
  if (statePath) {
    return statePath;
  }
  const homeDir = globalThis.nodeRepl?.homeDir || os.homedir();
  if (homeDir) {
    return path.join(homeDir, ".codex", "psst-gpt", "app-sessions.json");
  }
  return path.join(os.tmpdir(), "psst-gpt", "app-sessions.json");
}

function publicAppSession(session) {
  return {
    relaySessionId: session.relaySessionId,
    surface: session.surface,
    title: session.title,
    summary: session.summary,
    keywords: session.keywords,
    status: session.status,
    mode: session.mode,
    background: session.background,
    statePath: session.statePath,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function summarizeMessages(messages = []) {
  const firstUser = messages.find((message) => message.role === "user")?.text ?? "";
  const lastAssistant =
    [...messages].reverse().find((message) => message.role === "assistant")?.text ?? "";
  return trimForSummary([firstUser, lastAssistant].filter(Boolean).join(" -> "));
}

function extractKeywords(messages = []) {
  const text = messages
    .map((message) => message.text)
    .join(" ")
    .replace(/\s+/g, " ");
  const tokens = text.match(/[\p{Script=Han}]{2,}|[A-Za-z0-9][A-Za-z0-9_-]{2,}/gu) ?? [];
  return dedupe(tokens.map((token) => token.toLowerCase())).slice(0, 24);
}

function trimForSummary(text = "") {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 260 ? `${clean.slice(0, 257)}...` : clean;
}

function dedupe(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function codedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

async function main() {
  const rawOptions = process.argv[2] ?? "{}";
  const options = JSON.parse(rawOptions);
  const command = options.command || "run";
  let result;

  if (command === "run") {
    result = await runPsstGPT(options);
  } else if (command === "start") {
    result = await startPsstGPT(options);
  } else if (command === "continue") {
    result = await continuePsstGPT(options);
  } else if (command === "poll") {
    result = await pollPsstGPT(options);
  } else if (command === "list") {
    result = await listPsstGPTSessions(options);
  } else if (command === "state") {
    result = await readPsstGPTState(options);
  } else {
    throw codedError("PSST_GPT_CLI_COMMAND_UNSUPPORTED", `Unsupported command: ${command}`);
  }

  if (options.output === "text" && result?.finalDeliveryText) {
    process.stdout.write(`${result.finalDeliveryText}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (executedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const payload = {
      ok: false,
      code: error?.code ?? "PSST_GPT_FAILED",
      message: error?.message ?? String(error),
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  });
}

export const __testing = {
  extractAssistantTextFromAppState,
  transcriptContainsPrompt,
  isAppResponseCompleteSnapshot,
  isAppTransientText,
  isAppUiText,
  formatAppFinalDeliveryText,
  assertSupportedAppRelayOptions,
  messagesForAppRelay,
};
