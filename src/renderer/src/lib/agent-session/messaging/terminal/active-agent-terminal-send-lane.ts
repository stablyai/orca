import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RuntimeTerminalClientPaste } from '../../../../../../shared/terminal/runtime/runtime-terminal-send-contract'
import { createNonSecureContextUuid } from '../../../../../../shared/identifiers/non-secure-context-uuid'

// Why per window: a host keeps each lane's latest paste, and only this window's lane is serial.
const clientPasteLane = createNonSecureContextUuid()
let clientPasteSeq = 0

/** Names the next guarded paste so its outcome can be asked about if its reply is lost. */
export function nextClientPaste(): RuntimeTerminalClientPaste {
  clientPasteSeq += 1
  return { lane: clientPasteLane, seq: clientPasteSeq }
}

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

/** An accepted paste whose submission this window has not confirmed. */
export type UnsentTerminalPaste = {
  /** `Date.now()` after which an Enter would submit it rather than land inside it. */
  settlesAt: number
  /** Generation a later submit or cancellation must exceed to resolve this draft. */
  inputGeneration?: number
  /** A later note must not submit this draft before explicit resolution. */
  awaitsUserEnter: boolean
  /** A lost Enter reply must not be mistaken for proof that nothing was sent. */
  enterOutcome: 'not-sent' | 'unknown'
  /** Set while this paste's own outcome is unknown (its reply was lost or ambiguous): the host's
   *  receipt for it decides whether any text reached the terminal. */
  pasteOutcome?: {
    clientPaste: RuntimeTerminalClientPaste
    before: UnsentTerminalPaste | undefined
  }
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
