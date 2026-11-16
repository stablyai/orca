/** Share marker timing across daemon/relay/local transports to prevent double startup delivery and unnecessary waits. */

/** zsh precmd/bash PROMPT_COMMAND emit when input is ready; other wrapped shells emit during startup before the reader. */
export function shellReadyMarkerComesFromLineEditor(shellPath: string): boolean {
  const shellName = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  return shellName === 'bash' || shellName === 'zsh'
}
