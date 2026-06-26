import assert from "node:assert/strict";
import test from "node:test";
import { __testing } from "./psst_gpt.mjs";

test("extractAssistantTextFromAppState reads text after the matching prompt", () => {
  const prompt = "Reply exactly: OK PsstGPT smoke 2026-06-26";
  const state = {
    transcriptTexts: [
      "Older answer",
      prompt,
      "Thought for 2s",
      "OK PsstGPT smoke 2026-06-26",
      "Ask anything",
    ],
  };

  assert.equal(
    __testing.extractAssistantTextFromAppState(state, prompt),
    "OK PsstGPT smoke 2026-06-26"
  );
});

test("extractAssistantTextFromAppState uses the latest matching prompt", () => {
  const prompt = "Summarize this";
  const state = {
    transcriptTexts: [
      prompt,
      "First answer",
      prompt,
      "Second answer",
    ],
  };

  assert.equal(
    __testing.extractAssistantTextFromAppState(state, prompt),
    "Second answer"
  );
});

test("transcriptContainsPrompt handles long prompt excerpts", () => {
  const prompt = "A".repeat(120);
  const state = {
    transcriptTexts: [`${"A".repeat(90)} clipped by accessibility`],
  };

  assert.equal(__testing.transcriptContainsPrompt(state, prompt), true);
});

test("completion requires stable non-transient assistant text", () => {
  assert.equal(
    __testing.isAppResponseCompleteSnapshot({
      assistantText: "Thinking",
      textStableForMs: 60000,
      isAnswering: false,
    }),
    false
  );

  assert.equal(
    __testing.isAppResponseCompleteSnapshot({
      assistantText: "Final answer",
      textStableForMs: 1000,
      isAnswering: false,
    }),
    false
  );

  assert.equal(
    __testing.isAppResponseCompleteSnapshot({
      assistantText: "Final answer",
      textStableForMs: 8000,
      isAnswering: false,
    }),
    true
  );
});

test("unsupported PsstGPT options fail explicitly", () => {
  assert.throws(
    () => __testing.assertSupportedAppRelayOptions({
      prompt: "Analyze this file",
      attachments: [{ path: "/tmp/file.txt" }],
    }),
    /Unsupported option\(s\): attachments/
  );

  assert.throws(
    () => __testing.assertSupportedAppRelayOptions({
      prompt: "Use 5.5 Pro",
      model: "5.5",
      mode: "pro",
    }),
    /model\/mode\/effort selection/
  );

  assert.throws(
    () => __testing.assertSupportedAppRelayOptions({
      prompt: "Foreground this",
      background: false,
    }),
    /foreground mode/
  );

  assert.throws(
    () => __testing.assertSupportedAppRelayOptions({
      prompt: "Recover the window",
      allowWindowRecovery: true,
    }),
    /window recovery/
  );
});

test("final delivery includes app session id", () => {
  assert.equal(
    __testing.formatAppFinalDeliveryText({
      assistantText: "Visible app answer",
      relaySessionId: "app-123",
    }),
    "Visible app answer\n\nPsstGPT session: app-123"
  );
});

test("messagesForAppRelay appends assistant text once", () => {
  const messages = __testing.messagesForAppRelay(
    "Prompt",
    "Answer",
    [{ index: 0, role: "user", text: "Prompt" }]
  );

  assert.deepEqual(messages, [
    { index: 0, role: "user", text: "Prompt" },
    { index: 1, role: "assistant", text: "Answer" },
  ]);

  const unchanged = __testing.messagesForAppRelay("Prompt", "Answer", messages);
  assert.deepEqual(unchanged, messages);
});
