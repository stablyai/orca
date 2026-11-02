// A synthesized saved restore of an env-owned agent store asks Orca, from inside the agent's own
// shell invocation, whether its conversation still exists in the store that invocation reads.
// Authority is a private one-shot function the root shell installs at startup, outside any
// recalled command text; the generated line only calls it if it still exists.
import { quoteStartupArg, tokenizeStartupCommand } from './tui-agent-startup-shell'

/** The pane's bundled CLI; inert without the private entry. */
export const SAVED_RESTORE_CHECK_ENV = 'ORCA_SAVED_RESTORE_CHECK'
/** Main's prebuilt fresh argument tail: portable-quoted for POSIX/fish, a JSON array for PowerShell. */
export const SAVED_RESTORE_FRESH_ARGS_ENV = 'ORCA_SAVED_RESTORE_FRESH_ARGS'
/** The check's whole budget in milliseconds, counted from the CLI's own start. */
export const SAVED_RESTORE_BUDGET_ENV = 'ORCA_SAVED_RESTORE_BUDGET_MS'
/** The root shell's installer inputs: the entry name and the restore script path (no extension).
 *  Orca's wrapper reads and removes both before user startup files run. */
export const SAVED_RESTORE_ENTRY_ENV = 'ORCA_SAVED_RESTORE_ENTRY'
export const SAVED_RESTORE_SCRIPT_ENV = 'ORCA_SAVED_RESTORE_SCRIPT'
export const SAVED_RESTORE_FRESH_EXIT_CODE = 75
/** The store selectors the check reports from the invocation's own env. */
export const SAVED_RESTORE_ROOT_KEYS = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'XDG_DATA_HOME',
  'OPENCODE_DB'
] as const
export const SAVED_RESTORE_CHECK_COMMAND = ['agent', 'saved-restore-check'] as const

// Main appends this to the original command; the PTY host that knows the receiving shell turns
// it into that shell's dispatch, or drops it. Only Orca's arm writes it.
const ANNOTATION = /^([^\n]*) # __orca_saved_restore:([0-9a-f]{16}):([0-9a-f]{32})$/

export function annotateSavedRestore(command: string, entry: string, token: string): string {
  return `${command} # __orca_saved_restore:${entry}:${token}`
}

function readAnnotation(command: string) {
  const match = ANNOTATION.exec(command)
  return match ? { original: match[1], entry: match[2], token: match[3] } : null
}

/** The command an annotated line runs, for readers that recognize agents by command. */
export function withoutSavedRestoreAnnotation(command: string): string {
  return readAnnotation(command)?.original ?? command
}

function shellName(shellPath: string | undefined): string {
  return (shellPath?.split(/[\\/]/).pop() ?? '')
    .replace(/^-/, '')
    .replace(/\.exe$/i, '')
    .toLowerCase()
}

/** The receiving shell's line: the private entry if this root shell still has it, else the
 *  original command. Shells without an Orca installer always get the original. */
export function renderSavedRestoreStartupCommand(
  command: string,
  shellPath: string | undefined
): string {
  const annotated = readAnnotation(command)
  if (!annotated) {
    return command
  }
  const { original, entry, token } = annotated
  const shell = shellName(shellPath)
  const powershell = shell === 'powershell' || shell === 'pwsh'
  const callable = powershell && original.startsWith('& ') ? original.slice(2) : original
  const words = tokenizeStartupCommand(callable, powershell ? 'powershell' : 'posix')
  if (!words.ok || words.tokens.length === 0) {
    return original
  }
  const quote = (value: string) => quoteStartupArg(value, powershell ? 'powershell' : 'posix')
  const call = `__orca_sr_${entry} ${quote(token)} ${quote(original)} ${words.tokens.map(quote).join(' ')}`
  if (shell === 'bash' || shell === 'zsh') {
    return `if typeset -f __orca_sr_${entry} >/dev/null 2>&1; then ${call}; else ${original}; fi`
  }
  if (shell === 'fish') {
    return `if functions -q __orca_sr_${entry}; ${call}; else; ${original}; end`
  }
  return powershell
    ? `if (Test-Path function:__orca_sr_${entry}) { ${call} } else { ${original} }`
    : original
}

/** bash/zsh, before user startup files: take the installer inputs into unexported shell state. */
export const POSIX_SAVED_RESTORE_CAPTURE = `__orca_sr_entry="\${${SAVED_RESTORE_ENTRY_ENV}:-}" __orca_sr_script="\${${SAVED_RESTORE_SCRIPT_ENV}:-}"
builtin unset ${SAVED_RESTORE_ENTRY_ENV} ${SAVED_RESTORE_SCRIPT_ENV}`

/** bash/zsh, after Orca's agent functions: an armed restore loads its script, which installs the
 *  entry once. Nothing runs for any other start. */
export const POSIX_SAVED_RESTORE_INSTALL = `if [ -n "\${__orca_sr_entry:-}" ] && [ -r "\${__orca_sr_script:-}.sh" ]; then
  . "\${__orca_sr_script}.sh"
fi
builtin unset __orca_sr_entry __orca_sr_script`

/** fish -C initialization (root shell argv only), after Orca's agent functions. */
export const FISH_SAVED_RESTORE_INSTALL = `if set -q ${SAVED_RESTORE_ENTRY_ENV}
  set -g __orca_sr_entry $${SAVED_RESTORE_ENTRY_ENV}
  set -l __orca_sr_script $${SAVED_RESTORE_SCRIPT_ENV}
  set -e ${SAVED_RESTORE_ENTRY_ENV}
  set -e ${SAVED_RESTORE_SCRIPT_ENV}
  test -r "$__orca_sr_script.fish"; and source "$__orca_sr_script.fish"
  set -e __orca_sr_entry
end`

/** PowerShell bootstrap, after Orca's agent wrappers under the FullLanguage guard. Kept to one
 *  short line: every PowerShell start carries it in its encoded command. */
export const POWERSHELL_SAVED_RESTORE_INSTALL = `if ($env:${SAVED_RESTORE_ENTRY_ENV}) { $orcaSrEntry = $env:${SAVED_RESTORE_ENTRY_ENV}; $orcaSrScript = "$env:${SAVED_RESTORE_SCRIPT_ENV}.ps1"; Remove-Item Env:${SAVED_RESTORE_ENTRY_ENV}, Env:${SAVED_RESTORE_SCRIPT_ENV} -ea 0; try { . ([scriptblock]::Create([IO.File]::ReadAllText($orcaSrScript))) } catch {}; Remove-Variable orcaSrEntry, orcaSrScript -ea 0 }`
