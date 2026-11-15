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

/** What a person reads when a terminal was held; the raw code stays for programs that match it. */
export function wslDistroHoldUserMessage(hold: {
  distro: string
  state: WslDistroHoldState
}): string {
  return hold.state === 'stopped'
    ? `The WSL distro ${hold.distro} is stopped, so Orca didn't start this terminal. Start the distro, then try again.`
    : `Orca couldn't check whether the WSL distro ${hold.distro} is running, so it didn't start this terminal. Start the distro, then try again.`
}

/** An RPC failure's readable message and data for a held terminal, or null when it is not one. */
export function wslDistroHoldRpcFailure(message: string): {
  message: string
  data: { wslDistroHold: { distro: string; state: WslDistroHoldState } }
} | null {
  const hold = parseWslDistroHold(message)
  return hold ? { message: wslDistroHoldUserMessage(hold), data: { wslDistroHold: hold } } : null
}

/** Text with any hold code inside made readable: hosts that build warnings from errors keep the cause. */
export function readableWslDistroHoldText(text: string): string {
  const found = findWslDistroHoldInText(text)
  return found?.form === 'code'
    ? text.split(found.matched).join(wslDistroHoldUserMessage(found.hold))
    : text
}

/**
 * A hold named in text, as its code or its readable sentence (which RPC failures and warnings
 * carry), with the exact substring, so a client can swap in its own language.
 */
export function findWslDistroHoldInText(text: string): {
  hold: { distro: string; state: WslDistroHoldState }
  matched: string
  form: 'code' | 'sentence'
} | null {
  const hold = parseWslDistroHold(text)
  if (hold) {
    return { hold, matched: wslDistroHoldMessage(hold.distro, hold.state), form: 'code' }
  }
  for (const state of ['stopped', 'unverifiable'] as const) {
    // The sentence is built here, so its fixed parts locate the distro between them.
    const [before, after] = wslDistroHoldUserMessage({ distro: '\0', state }).split('\0')
    const start = text.indexOf(before)
    const end = start === -1 ? -1 : text.indexOf(after, start + before.length)
    const distro = end === -1 ? '' : text.slice(start + before.length, end)
    if (distro && !/\s/.test(distro)) {
      return { hold: { distro, state }, matched: `${before}${distro}${after}`, form: 'sentence' }
    }
  }
  return null
}
