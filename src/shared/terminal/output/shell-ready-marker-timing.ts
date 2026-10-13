/** Share marker timing across daemon/relay/local transports to prevent double startup delivery and unnecessary waits. */

/** True when the marker rides the shell's line editor (zsh precmd, bash PROMPT_COMMAND, Unix pwsh's wrapped prompt right before PSConsoleHostReadLine reads); other wrapped shells emit during startup before the reader. Windows pwsh startup commands ride the launch args and never queue behind the marker. */
export function shellReadyMarkerComesFromLineEditor(shellPath: string): boolean {
  const shellName = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  if (shellName === 'bash' || shellName === 'zsh') {
    return true
  }
  return (
    process.platform !== 'win32' &&
    (shellName === 'pwsh' ||
      shellName === 'pwsh.exe' ||
      shellName === 'powershell' ||
      shellName === 'powershell.exe')
  )
}
