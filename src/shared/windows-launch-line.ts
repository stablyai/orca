/**
 * What a typed Windows launch line does to its prompt. Nothing stages a Windows line, so this is per
 * shell, from lines measured through each one (stack QA, native agent executables, 2026-10-02):
 * `exact` arrived byte for byte, `damaged` was measured lost or changed, and `uncertain` was not
 * measured, so the caller does there what main does on its path.
 */
import type { WindowsPowerShell } from './launch-host'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import { TYPED_STARTUP_LINE_BUDGET_BYTES } from './typed-startup-line'

export type WindowsLineVerdict = 'exact' | 'damaged' | 'uncertain'

/** cmd.exe's line cap: an 8,172-character line ran, an 8,263-character one did not start. */
export const WINDOWS_CMD_LINE_MAX_CHARS = 8191

/** CreateProcess's 32,767-character command line, less room for the resolved executable path.
 *  Measured: 20,552 characters arrived, 99,072 never started. */
export const WINDOWS_POWERSHELL_LINE_MAX_CHARS = 32_000

/** A multi-line PowerShell line: 356 bytes arrived; 9,088 lost its line breaks (5.1) or ran its
 *  lines as commands (7). Exact is held to the typed budget, damaged from the measured failure. */
const WINDOWS_POWERSHELL_MULTI_LINE_DAMAGED_BYTES = 9_088

/** Git Bash: 9,089 characters arrived whole, line breaks included (typed in 17 s); 20,551 never
 *  started. */
export const WINDOWS_POSIX_LINE_EXACT_MAX_CHARS = 9_089
const WINDOWS_POSIX_LINE_DAMAGED_CHARS = 20_551

const encoder = new TextEncoder()

/** Control bytes other than a line feed: Tab and carriage return were measured, the rest not. */
function keyBytes(line: string): { tabOrReturn: boolean; unmeasured: boolean } {
  let tabOrReturn = false
  let unmeasured = false
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i)
    // Measured: a Tab and a bare carriage return; a CR before a line feed was not.
    if (code === 0x09 || (code === 0x0d && line.charCodeAt(i + 1) !== 0x0a)) {
      tabOrReturn = true
    } else if ((code < 0x20 && code !== 0x0a) || code === 0x7f) {
      unmeasured = true
    }
  }
  return { tabOrReturn, unmeasured }
}

/** An agent spelled as a `.cmd`/`.bat` shim, whose cmd.exe re-reads its arguments. A bare name
 *  may be either, so only the spelled-out shim counts. */
function launchesThroughCmdShim(line: string): boolean {
  const target = /^(?:&\s*)?(?:'([^']*)'|"([^"]*)"|(\S+))/.exec(line.trim())
  return /\.(?:cmd|bat)$/i.test(target?.[1] ?? target?.[2] ?? target?.[3] ?? '')
}

function shellVerdict(
  line: string,
  shell: AgentStartupShell,
  multiLine: boolean
): WindowsLineVerdict {
  if (shell === 'cmd') {
    // A line feed submits early; `"`, `%NAME%` and a trailing `\` arrive.
    return multiLine || line.length > WINDOWS_CMD_LINE_MAX_CHARS ? 'damaged' : 'exact'
  }
  if (shell === 'powershell') {
    if (line.length > WINDOWS_POWERSHELL_LINE_MAX_CHARS) {
      return 'damaged'
    }
    const bytes = encoder.encode(line).byteLength
    if (!multiLine || bytes <= TYPED_STARTUP_LINE_BUDGET_BYTES) {
      return 'exact'
    }
    return bytes >= WINDOWS_POWERSHELL_MULTI_LINE_DAMAGED_BYTES ? 'damaged' : 'uncertain'
  }
  // Git Bash: POSIX quoting arrived whole. A WSL pane never reaches this check.
  if (line.length <= WINDOWS_POSIX_LINE_EXACT_MAX_CHARS) {
    return 'exact'
  }
  return line.length >= WINDOWS_POSIX_LINE_DAMAGED_CHARS ? 'damaged' : 'uncertain'
}

function hasNonAscii(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    if (line.charCodeAt(i) > 0x7f) {
      return true
    }
  }
  return false
}

function withUnmeasuredKeys(verdict: WindowsLineVerdict, unmeasured: boolean): WindowsLineVerdict {
  return unmeasured && verdict === 'exact' ? 'uncertain' : verdict
}

export function windowsLaunchLineVerdict(
  prompt: string,
  line: string,
  shell: AgentStartupShell,
  /** The PowerShell the pane is spawned as (from `LaunchHost.windowsPaneShell`), when known. */
  windowsPowerShell: WindowsPowerShell | null
): WindowsLineVerdict {
  const keys = keyBytes(line)
  // Measured: cmd and Git Bash read a Tab or carriage return as a key (completion, or Enter, which
  // in cmd runs the rest as commands); both PowerShells carried them exactly.
  if (keys.tabOrReturn && shell !== 'powershell') {
    return 'damaged'
  }
  // Not measured: a non-ASCII prompt typed into cmd (Orca's cmd panes run `chcp 65001`, as main's
  // do, but no QA row carried one), so main's delivery decides.
  const unmeasured = keys.unmeasured || (shell === 'cmd' && hasNonAscii(line))
  // Why the prompt too: PowerShell quotes a multi-line prompt onto one physical line (`n escapes,
  // #23672), and the multi-line rows were measured by the prompt's line breaks, not the line's.
  const multiLine = line.includes('\n') || prompt.includes('\n')
  const verdict = withUnmeasuredKeys(shellVerdict(line, shell, multiLine), unmeasured)
  const legacyArgsDamage = prompt.includes('"') || prompt.endsWith('\\')
  if (shell === 'cmd' || !launchesThroughCmdShim(line)) {
    if (shell !== 'powershell' || verdict !== 'exact' || !legacyArgsDamage) {
      return verdict
    }
    // Measured: 5.1 hands every native command `"` and a trailing `\` the legacy way and breaks
    // them; 7 carried them exactly. Where the PowerShell is not known, main's delivery decides.
    return windowsPowerShell === 'powershell.exe'
      ? 'damaged'
      : windowsPowerShell === 'pwsh.exe'
        ? 'exact'
        : 'uncertain'
  }
  // Measured (#23962 W-1): PowerShell hands a shim `"` and a trailing `\` the legacy way, and the
  // shim's cmd.exe expands `%NAME%`.
  if (/%[^%\s]+%/.test(prompt) || (shell === 'powershell' && legacyArgsDamage)) {
    return 'damaged'
  }
  // The shim's cmd.exe also caps the line and cuts at a line break; not measured through a shim.
  return verdict === 'exact' && (multiLine || line.length > WINDOWS_CMD_LINE_MAX_CHARS)
    ? 'uncertain'
    : verdict
}
