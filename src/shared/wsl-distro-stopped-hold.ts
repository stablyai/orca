/**
 * A passive restore of a WSL bridge pane whose distro is not proven running: held, never started
 * (E9). The state says whether the read found it stopped or could not tell.
 */
export type WslDistroHoldState = 'stopped' | 'unverifiable'

const HOLD_ERRORS: Record<WslDistroHoldState, string> = {
  stopped: 'terminal_held_wsl_distro_stopped',
  unverifiable: 'terminal_held_wsl_distro_unverifiable'
}

export function wslDistroHoldMessage(distro: string, state: WslDistroHoldState): string {
  return `${HOLD_ERRORS[state]}:${distro}`
}

/** The distro and state a hold names, or null when the message is not one. */
export function parseWslDistroHold(
  message: string
): { distro: string; state: WslDistroHoldState } | null {
  for (const state of ['stopped', 'unverifiable'] as const) {
    const prefix = `${HOLD_ERRORS[state]}:`
    const start = message.indexOf(prefix)
    const distro = start === -1 ? '' : message.slice(start + prefix.length).split(/\s/)[0]
    if (distro) {
      return { distro, state }
    }
  }
  return null
}
