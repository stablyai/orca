import { callRuntimeRpc, hasRuntimeRpcErrorCode } from './runtime-rpc-client'
import {
  listClientHostedBrowserCloseIntents,
  type ClientHostedBrowserCloseIntentsByEnvironment
} from './client-hosted-browser-close-intents'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const REPLAY_TIMEOUT_MS = 15_000

/**
 * Codes that mean the runtime has definitively forgotten the page rather than failed to answer.
 * `browser_no_tab` is included because a runtime with no browser session at all cannot be holding
 * this page either; anything else is a "not now" and the intent has to survive for the next try.
 */
const PAGE_UNKNOWN_CODES = ['browser_tab_not_found', 'browser_no_tab', 'selector_not_found']

/** True when a failed close means the runtime has definitively forgotten the page — nothing left
 *  to resurrect, so no intent should be recorded or kept. Anything else is a "not now". */
export function isBrowserPageDefinitivelyGone(error: unknown): boolean {
  return PAGE_UNKNOWN_CODES.some((code) => hasRuntimeRpcErrorCode(error, code))
}

const replayingEnvironmentIds = new Set<string>()

export type ClientHostedBrowserCloseIntentReplayStore = {
  clientHostedBrowserCloseIntentsByEnvironment: ClientHostedBrowserCloseIntentsByEnvironment
  clearClientHostedBrowserCloseIntents: (
    environmentId: string,
    browserPageIds: readonly string[]
  ) => void
}

/**
 * Re-issues the closes an environment never heard.
 *
 * Deliberately the same `browser.tabClose` a live close sends -- there is no replay method and no
 * new wire state, so an old runtime settles these exactly as it settles an ordinary close. An
 * intent clears on success or on a definitive page-unknown answer; a transport failure leaves it,
 * because "we could not ask" must never read as "it is gone".
 */
export async function replayClientHostedBrowserCloseIntents(
  environmentId: string,
  // Why passed rather than imported: this runs from a store slice, and reaching back into the
  // store from here closes an import cycle that leaves the slice factories undefined at load.
  store: ClientHostedBrowserCloseIntentReplayStore
): Promise<void> {
  const trimmed = environmentId.trim()
  if (!trimmed || replayingEnvironmentIds.has(trimmed)) {
    return
  }
  const intents = listClientHostedBrowserCloseIntents(
    store.clientHostedBrowserCloseIntentsByEnvironment,
    trimmed
  )
  if (intents.length === 0) {
    return
  }
  replayingEnvironmentIds.add(trimmed)
  try {
    const settled: string[] = []
    for (const intent of intents) {
      try {
        await callRuntimeRpc(
          { kind: 'environment', environmentId: trimmed },
          'browser.tabClose',
          {
            worktree: toRuntimeWorktreeSelector(intent.worktreeId),
            page: intent.browserPageId
          },
          { timeoutMs: REPLAY_TIMEOUT_MS }
        )
        settled.push(intent.browserPageId)
      } catch (error) {
        if (isBrowserPageDefinitivelyGone(error)) {
          settled.push(intent.browserPageId)
          continue
        }
        console.warn(
          '[client-hosted-browser] deferred replaying a close for',
          intent.browserPageId,
          error
        )
      }
    }
    store.clearClientHostedBrowserCloseIntents(trimmed, settled)
  } finally {
    replayingEnvironmentIds.delete(trimmed)
  }
}

export function resetClientHostedBrowserCloseIntentReplayForTests(): void {
  replayingEnvironmentIds.clear()
}
