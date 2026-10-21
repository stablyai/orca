# Real Pi dialog verification

Use Pi 0.84.4 or newer. Older Pi does not emit `ui_prompt_start` / `ui_prompt_end`.
The checked-in extension only opens dialogs; it does not call a model or send synthetic
Orca hook events.

1. Launch an isolated Orca development instance with CDP using the Electron skill.
2. Open one terminal in a git worktree or folder workspace. Start Pi with Orca's
   generated status extension and this additional extension:

   ```sh
   pi --offline --no-session -e /absolute/path/to/orca/tests/tools/pi-ui-prompt-extension.mjs
   ```

   If launching Pi directly through `node` or disabling extension discovery, explicitly
   load Orca's generated `orca-agent-status.ts` with another `-e` argument.

3. Leave Pi at its input editor, then run from the Orca repository:

   ```sh
   node tests/tools/pi-ui-prompt-cdp-smoke.mjs http://127.0.0.1:9333 /path/to/proof
   ```

The smoke check requires one terminal and one Pi status entry in the isolated instance.
It opens all five real Pi dialogs, answers the selector, and cancels each dialog.
It asserts backend `waiting` plus the terminal tab's visible **Needs attention** icon,
then backend `done` plus the visible completion icon. Screenshots are saved for both
states. Custom-dialog cancellation sends a plain Escape through the real PTY;
the standard dialogs use browser keyboard events.

For manual verification, run `/orca-modal select`, `/orca-modal confirm`,
`/orca-modal input`, `/orca-modal editor`, or `/orca-modal custom` inside Pi.

The separate runtime test covers active-agent close (`working`), idle close (`done`),
overlap, unrelated tool events, and rejected dialog promises using Pi's actual runner:

```sh
node tests/tools/pi-ui-prompt-runtime-smoke.mjs /path/to/installed/pi-coding-agent
```

These local checks do not prove live SSH/network-failure behavior, Windows/WSL,
mobile rendering, or startup selectors created before Pi's extension runner exists.
