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
 * `PROMPT_COMMAND`), so it arrives at the same moment the prompt can accept input.
 * Every other wrapped shell emits it from startup, ahead of the reader.
 */
export function shellReadyMarkerComesFromLineEditor(shellPath: string): boolean {
  const shellName = shellPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  return shellName === 'bash' || shellName === 'zsh'
}
