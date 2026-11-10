import { optionName } from './print-mode-headless-command'

// The launcher reaches the TUI only bare or through `tui`/`resume`; chat, review and its other subcommands exit.
const AIWORK_TUI_SUBCOMMANDS: ReadonlySet<string> = new Set(['tui', 'resume'])
// aiwork-tui runs one input loop with --once and only validates config with --check-keybindings.
const AIWORK_TUI_ONE_SHOT_FLAGS: ReadonlySet<string> = new Set(['--once', '--check-keybindings'])

/** The command's basename without a Windows launcher extension. */
function executableName(token: string): string {
  const basename = token.split(/[\\/]/).pop() ?? token
  return basename.toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '')
}

/** Whether an AiWork command line runs once and exits rather than opening its TUI. */
export function isAiworkHeadlessOneShotCommand(tokens: readonly string[]): boolean {
  if (executableName(tokens[0] ?? '') === 'aiwork-tui') {
    for (let index = 1; index < tokens.length; index += 1) {
      if (tokens[index] === '--') {
        return false
      }
      if (AIWORK_TUI_ONE_SHOT_FLAGS.has(optionName(tokens[index]))) {
        return true
      }
    }
    return false
  }
  const subcommand = tokens.slice(1).find((token) => !token.startsWith('-'))
  return subcommand !== undefined && !AIWORK_TUI_SUBCOMMANDS.has(subcommand)
}
