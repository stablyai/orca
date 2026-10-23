/**
 * When in a shell's startup Orca's OSC 777 ready marker is published.
 *
 * Why this is a decision of its own: it is what separates "waiting for the marker
 * is free" from "waiting for the marker costs the user real startup latency", and
 * all three transports (daemon, relay, local provider) have to answer it the same
 * way or a startup command is delivered twice on one of them.
 */

/**
 * True when the marker rides the shell's line editor (zsh `precmd`, bash
 * `PROMPT_COMMAND`, pwsh's wrapped `prompt` function invoked right before
 * `PSConsoleHostReadLine` reads), so it arrives at the same moment the prompt can
 * accept input. Every other wrapped shell emits it from startup, ahead of the
 * reader. The pwsh case is Unix-only: Windows pwsh startup commands ride the
 * launch args and never queue behind the marker.
 */
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
