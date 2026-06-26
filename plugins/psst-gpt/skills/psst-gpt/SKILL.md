---
name: psst-gpt
description: Use when the user asks to relay a prompt through the ChatGPT macOS desktop app instead of Chrome, or explicitly says to use the ChatGPT app from Codex.
---

# PsstGPT

This skill relays a Codex task to the macOS ChatGPT desktop app through Accessibility automation.
It is separate from Chrome-backed GPT Relay and does not use the Codex Chrome extension.

Credit: PsstGPT is an independent desktop-app implementation, inspired by the original Chrome-backed GPT Relay by Prompt Case. Thanks to him for the relay concept and Codex plugin workflow.

When the user invokes `$psst-gpt` or selects `psst-gpt` from the slash command list, treat the remaining user text as the prompt to relay to the ChatGPT app.

## What It Does

Use the helper script at `../../scripts/psst_gpt.mjs` to:

1. Launch or wake `ChatGPT.app` with `open -g`, without foregrounding it.
2. Ensure an existing app window and composer are available.
3. Start a new app chat by default.
4. Write the user's text prompt into the app composer.
5. Send the prompt.
6. Wait until the visible assistant response is stable.
7. Store app-session metadata.
8. Return `finalDeliveryText` to Codex.

## Required Setup

- macOS.
- ChatGPT desktop app installed in `/Applications` or `~/Applications`.
- A ChatGPT app window is already open. The helper will not open, recover, or foreground a missing window.
- User is already signed in to the ChatGPT app.
- macOS Accessibility automation is enabled for the process running Codex and `/usr/bin/osascript`.

Do not inspect cookies, local storage, passwords, app databases, browser session stores, or hidden ChatGPT state.

## Safety Boundaries

- Only send prompts that the user explicitly asks to relay to the ChatGPT app.
- PsstGPT supports text prompts in the active ChatGPT app surface.
- The relay is strict-background only. Do not pass `background: false`; do not request window recovery.
- If the helper returns `PSST_GPT_WINDOW_MISSING_BACKGROUND`, ask the user to manually open a ChatGPT app window when convenient. Do not auto-click Dock, use screenshots, or foreground the app.
- Model selection, reasoning mode selection, file attachments, Projects, GPT Apps, Create image artifact export, and Deep Research Markdown export are not implemented until verified through the app UI. If requested, report `PSST_GPT_UNSUPPORTED_OPTION`.
- If the app shows login, CAPTCHA, verification, permission, or account prompts, stop and report the helper error.
- If the app is still answering, keep waiting or poll the same session. Do not answer the user's task locally as a substitute.
- The helper reports only visible app UI state. Do not claim hidden backend model state.
- Polling can only inspect the currently visible app conversation; PsstGPT cannot reopen stored conversations by URL.

## Node REPL Usage

Use an absolute import path resolved from this skill file:

```text
<plugin-root>/scripts/psst_gpt.mjs
```

Start a new app chat:

```js
const { runPsstGPT } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
const result = await runPsstGPT({
  prompt: "User prompt here",
  background: true,
  timeoutMs: 30 * 60 * 1000
});
nodeRepl.write(result.finalDeliveryText);
```

Continue in the active app chat:

```js
const { continuePsstGPT } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
const result = await continuePsstGPT({
  background: true,
  prompt: "Continue with one more paragraph."
});
nodeRepl.write(result.finalDeliveryText);
```

Poll a pending active app session:

```js
const { pollPsstGPT } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
const result = await pollPsstGPT({
  query: "keyword from the original prompt",
  background: true,
  timeoutMs: 30 * 60 * 1000
});
nodeRepl.write(result.finalDeliveryText);
```

List stored app sessions:

```js
const { listPsstGPTSessions } = await import("/absolute/path/to/plugin/scripts/psst_gpt.mjs");
nodeRepl.write(JSON.stringify(await listPsstGPTSessions({ limit: 10 }), null, 2));
```

CRITICAL FINAL OUTPUT RULE:
If any helper returns `status: "complete"`, `mustReturnFinalDelivery: true` or
`mustReturnVerbatim: true`, and a non-empty `finalDeliveryText`, the Codex final answer MUST be
exactly `result.finalDeliveryText`.
Do not add a summary before it. Do not shorten it. Do not rewrite it. Do not omit lines.
