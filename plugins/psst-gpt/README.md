# PsstGPT

PsstGPT is a Codex plugin skill for relaying text prompts to the macOS ChatGPT desktop app in strict background mode.

For the full install guide, see the repository [README](../../README.md).

## Invoke

Use the skill directly:

```text
$psst-gpt <task to send to the ChatGPT app>
```

In Codex CLI, `/psst-gpt` is not the supported command path. Use `$psst-gpt`, or run `/skills` and select `psst-gpt`.

## Requirements

- macOS.
- ChatGPT desktop app installed and signed in.
- One ChatGPT app window already open.
- Accessibility permission for Codex and `/usr/bin/osascript`.

## Cross-Platform Status

PsstGPT is currently macOS-only.

Windows support is feasible, but it needs a separate Windows UI Automation backend for the ChatGPT Windows app and must be tested for strict no-focus/no-popup behavior before release.

Linux is not currently targeted because OpenAI's current desktop download page lists macOS and Windows desktop apps, not a Linux ChatGPT desktop app.

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

Unsupported options fail with `PSST_GPT_UNSUPPORTED_OPTION`.

Credit: PsstGPT is an independent desktop-app implementation, inspired by the original Chrome-backed [GPT Relay](https://github.com/Toolsai/GPT-Relay-Codex-Plugin-) by Prompt Case. Thanks to him for the relay concept and Codex plugin workflow.
