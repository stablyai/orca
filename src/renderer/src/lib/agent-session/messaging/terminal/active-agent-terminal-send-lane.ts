import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

const laneTails = new Map<string, Promise<void>>()
type LaneDraft = { paste?: UnsentTerminalPaste; ptyId?: string; retired?: boolean }
const unsentPastes = new Map<string, LaneDraft>()

export function forgetTerminalNoteDraft(ptyId: string): void {
  for (const [key, draft] of unsentPastes) {
    if (draft.ptyId === ptyId) {
      draft.retired = true
      draft.paste = undefined
      unsentPastes.delete(key)
    }
  }
}

/** A paste this window left in a terminal without its Enter. */
export type UnsentTerminalPaste = {
  /** `Date.now()` after which an Enter would submit it rather than land inside it. */
  settlesAt: number
  /** Input generation the user must resolve with a later submit or cancellation. */
  inputGeneration?: number
  /** The user was told to press Enter there, so no later send may submit it for them. */
  awaitsUserEnter: boolean
}

export type TerminalSendLane = {
  unsentPaste: () => UnsentTerminalPaste | undefined
  /** Remembers, or with `undefined` forgets, the paste left unsent in this terminal. */
  setUnsentPaste: (paste: UnsentTerminalPaste | undefined) => void
}

/** Runs one terminal's sends one at a time, in arrival order, so a send's Enter cannot land inside
 *  another send's paste. Orders this window's calls only: a send that rejects frees the lane while
 *  the host may still be working on it. The lane is free as soon as a send has its result.
 *  A send that cannot start within `maxWaitMs` never runs: it answers `{ laneBusy: true }`. */
export async function runInTerminalSendLane<T>(
  runtimeTarget: RuntimeClientTarget,
  terminalHandle: string,
  send: (lane: TerminalSendLane) => Promise<T>,
  maxWaitMs: number,
  ptyId?: string
): Promise<T | { laneBusy: true }> {
  const runtime =
    runtimeTarget.kind === 'environment' ? `environment:${runtimeTarget.environmentId}` : 'local'
  const key = `${runtime}\n${terminalHandle}`
  const previous = laneTails.get(key) ?? Promise.resolve()
  let release = (): void => {}
  const tail = new Promise<void>((resolve) => {
    release = resolve
  })
  laneTails.set(key, tail)
  void tail.then(() => {
    if (laneTails.get(key) === tail) {
      laneTails.delete(key)
    }
  })
  if (!(await turnCameWithin(previous, maxWaitMs))) {
    // Leaving the queue must not let the send behind overtake the one ahead.
    void previous.then(release)
    return { laneBusy: true }
  }
  const draft = unsentPastes.get(key) ?? { ptyId }
  unsentPastes.set(key, draft)
  try {
    return await send({
      unsentPaste: () => draft.paste,
      setUnsentPaste: (paste) => {
        if (!draft.retired) {
          draft.paste = paste
        }
      }
    })
  } finally {
    if (!draft.paste && unsentPastes.get(key) === draft) {
      unsentPastes.delete(key)
    }
    release()
  }
}

function turnCameWithin(previous: Promise<void>, maxWaitMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), maxWaitMs)
    void previous.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}
