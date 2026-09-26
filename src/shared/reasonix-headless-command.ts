import { isPrintModeHeadlessOneShotCommand } from './print-mode-headless-command'

// Why: Reasonix runs headless in two ways — `-p`/`--print` prints one response and
// exits, and the `run` subcommand streams a single task to stdout and exits. Neither
// hosts the interactive `code` TUI, so a pane must not be tagged as a live session.
// `run` matches past any position (a quoted TUI prompt never splits into a bare `run`
// token on its own), mirroring muse's `exec` subcommand dispatch.
export function isReasonixHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  if (tokens.slice(1).some((token) => token === 'run')) {
    return true
  }
  return isPrintModeHeadlessOneShotCommand(tokens)
}
