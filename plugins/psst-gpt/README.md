# PsstGPT

Local Codex plugin for relaying prompts to the macOS ChatGPT desktop app.

This plugin is intentionally separate from the Chrome-backed GPT Relay. It uses macOS Accessibility automation against `ChatGPT.app` (`com.openai.chat`) and stores its own app-session records in `~/.codex/psst-gpt/app-sessions.json`.

Credit: PsstGPT is an independent desktop-app implementation, inspired by the original Chrome-backed [GPT Relay](https://github.com/Toolsai/GPT-Relay-Codex-Plugin-) by Prompt Case. Thanks to him for the relay concept and Codex plugin workflow.

## Scope

- Uses `open -g` and Accessibility so the ChatGPT desktop app is not brought to the foreground.
- Requires an existing ChatGPT app window; it will not open, recover, or foreground a missing window.
- Starts a new chat by default.
- Writes text prompts directly into the app composer.
- Sends the prompt through `AXPress` Accessibility actions, not screenshots, OCR, or foreground keyboard focus.
- Reads visible transcript text from Accessibility.
- Waits for the assistant response to become stable.
- Supports continuing in the active app conversation.
- Supports polling the active app conversation for a stored pending session.
- Returns `finalDeliveryText` for verbatim Codex delivery.

## Boundaries

- macOS only.
- Requires Accessibility permission.
- Requires the user to already be signed in to the ChatGPT app.
- Requires a ChatGPT app window to already be open somewhere on the desktop.
- Strict background mode is enforced. `background: false` and window recovery are rejected.
- Does not inspect cookies, local storage, app databases, passwords, or browser/session stores.
- Does not currently automate model selection, file upload, Projects, GPT Apps, Create image artifact export, or Deep Research Markdown export.

Unsupported options fail with `PSST_GPT_UNSUPPORTED_OPTION`.
