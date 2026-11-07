import { createNonSecureContextUuid as createBrowserUuid } from '../../../shared/non-secure-context-uuid'
import type { GeneratedAgentInputNotice } from '../../../shared/generated-agent-input-notice'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { callRuntimeRpc } from './runtime-rpc-client'

const REGISTER = 'terminal.generatedInputNotices.register'
const LOCAL: RuntimeClientTarget = { kind: 'local' }
// An answer the caller waits for (never the send) may take this long before its own notice shows.
const REGISTRATION_WAIT_MS = 5_000
const WINDOW_KEY = 'orca.generatedInputNoticeWindow'

export type GeneratedInputNoticeFields = Omit<GeneratedAgentInputNotice, 'handle' | 'worktreeId'> &
  Partial<Pick<GeneratedAgentInputNotice, 'handle' | 'worktreeId'>>

let windowKey: string | null = null

/** This window's key for a paired host's private notices: one id per window, kept for the
 *  window's life (so a reload keeps reading its own), and scoped there under the authenticated
 *  pairing. It names an audience only; no notice text is stored with it. */
export function generatedInputNoticeWindow(): string {
  if (windowKey) {
    return windowKey
  }
  try {
    windowKey = globalThis.sessionStorage?.getItem(WINDOW_KEY) ?? null
    if (!windowKey) {
      windowKey = createBrowserUuid()
      globalThis.sessionStorage?.setItem(WINDOW_KEY, windowKey)
    }
  } catch {
    windowKey ??= createBrowserUuid()
  }
  return windowKey
}

/** A notice request names this window's audience when it goes to a paired host. */
export function noticeAudience(target: RuntimeClientTarget): { window?: string } {
  return target.kind === 'environment' ? { window: generatedInputNoticeWindow() } : {}
}

/** The paired host a window's request runs on, and this window's key there, with the runtime and
 *  pairing it answered with once known (required to observe or discard that host's copy). Told
 *  only to this window's own runtime, never to a host. */
export type GeneratedInputNoticeHost = {
  environmentId: string
  window: string
  runtimeId?: string
  pairingRevision?: number
}

// This window's runtime is this renderer's own version and takes the text in one request.
async function register(
  notice: GeneratedInputNoticeFields,
  extra: { pending?: boolean; owner?: GeneratedInputNoticeHost; targetGone?: boolean } = {}
): Promise<boolean> {
  const result = await callRuntimeRpc<{ retained?: boolean; discarded?: boolean }>(
    LOCAL,
    REGISTER,
    {
      ...notice,
      ...(extra.pending ? { pending: true } : {}),
      ...(extra.owner ? { owner: extra.owner } : {}),
      ...(extra.targetGone ? { targetGone: true } : {})
    },
    { timeoutMs: REGISTRATION_WAIT_MS }
  )
  // Discarded by an explicit Dismiss: settled, never shown again as a fallback.
  return result.retained === true || result.discarded === true
}

/** Registers one operation's notice with this window's runtime session. Never writes to a
 *  terminal; registering the same obligation again lands on the same record, and that runtime
 *  alone gives a paired host its copy. False (the caller then shows its own) when it refused,
 *  conflicted, failed, or did not answer in time: the wait is bounded whatever the transport does. */
export async function registerGeneratedInputNotice(
  notice: GeneratedInputNoticeFields
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), REGISTRATION_WAIT_MS)
  })
  try {
    return await Promise.race([register(notice).catch(() => false), late])
  } finally {
    clearTimeout(timer)
  }
}

/** Hands accepted text to this window's runtime as a pending obligation, without waiting: the
 *  send never waits on this, and a later registration of the same id lands on the same record.
 *  `owner` names the paired host the request is going to. */
export function holdGeneratedInputNotice(
  notice: GeneratedInputNoticeFields,
  extra: { owner?: GeneratedInputNoticeHost; targetGone?: boolean } = {}
): void {
  void register(notice, { pending: true, ...extra }).catch(() => {})
}

/** This window discards a notice: through its own runtime, which also owes the discard to the
 *  paired host holding a copy (`owner`) until that host applies it, offline or across a reload. */
export function dismissGeneratedInputNotice(
  id: string,
  owner?: GeneratedInputNoticeHost
): Promise<unknown> {
  return callRuntimeRpc(LOCAL, 'terminal.dismissGeneratedInputNotice', {
    id,
    ...(owner ? { owner } : {})
  })
}

/** This window's pending record for `id` is no longer needed: delivered, or its owner kept it.
 *  With `observedOwner`, the window shows that host's copy: this window's own copy, hidden or
 *  shown, gives way only when it was sent to exactly that runtime and pairing. */
export function settleGeneratedInputNotice(
  id: string,
  observedOwner?: GeneratedInputNoticeHost
): void {
  void callRuntimeRpc(LOCAL, REGISTER, {
    id,
    settle: true,
    text: '',
    agent: null,
    certainty: 'not-sent',
    ...(observedOwner ? { observed: observedOwner } : {})
  }).catch(() => {})
}

export { LOCAL as LOCAL_NOTICE_RUNTIME }
