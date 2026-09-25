/**
 * Recognizing a `zcode` build that cannot open a session.
 *
 * ZCode ships one agent runtime behind two front ends. The desktop app bundles the runtime
 * without `@zcode/tui`, because it draws its own window in Electron and would never call a
 * terminal renderer. Put that bundle on PATH as `zcode` and it answers `--version`, runs
 * `-p` headlessly, and passes `zcode doctor` — but dies the moment Orca asks it for an
 * interactive session.
 *
 * That combination is why this is worth detecting rather than documenting alone: Orca's own
 * auto-setup reports success (the hooks really are installed correctly), so the only visible
 * failure is a Node stack trace inside the pane, and it reads as a broken Orca integration.
 *
 * Evidence: `src/main/runtime/__fixtures__/zcode-missing-tui.txt`, a recorded PTY capture of
 * the desktop bundle refusing to start.
 */

// Why the module-resolution error and not the success path: a build that HAS the TUI but no
// TTY prints "TUI requires an interactive terminal.", which ZCode localizes (`TUI 需要交互式终端。`
// in zh-CN), so matching it would miss every non-English user. Node's own resolution failure
// is not localized and names the package directly.
//
// Both spellings are covered because the ESM loader reports `Cannot find package` while a CJS
// require path reports `Cannot find module`, and which one a given build hits depends on how
// it was bundled.
const ZCODE_MISSING_TUI_RE = /Cannot find (?:package|module) ['"]@zcode\/tui['"]/

/**
 * What a `zcode` build can do when asked for a session.
 *
 * `unknown` is a real answer, not a failure: a probe that could not run says nothing about
 * the build, and callers must not treat it as broken.
 */
export type ZCodeInteractiveCapability = 'interactive' | 'missing-tui' | 'unknown'

/** True when this output is ZCode reporting that its terminal UI is not installed. */
export function isZCodeMissingTuiOutput(output: string): boolean {
  return ZCODE_MISSING_TUI_RE.test(output)
}
