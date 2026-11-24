import { showBrowserOpenFailure } from '../workspace/workspace-browser-open-failure-toast'
import type { OpenHttpLinkOptions } from './http-link-destinations'
import type { BrowserOpenOutcome } from './browser-link-destination'

export type HttpLinkAdmission = 'admitted' | 'refused' | 'failed' | 'superseded'

/** Settles once; a throwing or rejecting consumer must not change how the open is projected. */
export function onceAdmission(
  consumer: ((outcome: HttpLinkAdmission) => void | Promise<void>) | undefined
): (outcome: HttpLinkAdmission) => void {
  let settled = false
  return (outcome) => {
    if (settled || !consumer) {
      settled = true
      return
    }
    settled = true
    try {
      const pending = consumer(outcome)
      if (pending && typeof pending.then === 'function') {
        pending.catch((error: unknown) =>
          console.error('[links] admission consumer failed:', error)
        )
      }
    } catch (error) {
      console.error('[links] admission consumer failed:', error)
    }
  }
}

export function admissionForBrowserOutcome(outcome: BrowserOpenOutcome): HttpLinkAdmission {
  if (outcome.status === 'opened') {
    return 'admitted'
  }
  if (outcome.status === 'superseded' || outcome.status === 'failed') {
    return outcome.status
  }
  return 'refused'
}

export function reportHttpLinkBrowserOpenFailure(error: unknown): void {
  showBrowserOpenFailure(error)
}

// Main's shell:openUrl silently ignores anything but http(s); check first so a resolve means it opened.
function isOpenableSystemUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export async function openSystemHttpLink(url: string): Promise<HttpLinkAdmission> {
  if (!isOpenableSystemUrl(url)) {
    return 'refused'
  }
  try {
    await window.api.shell.openUrl(url)
    return 'admitted'
  } catch {
    reportHttpLinkBrowserOpenFailure(null)
    return 'failed'
  }
}

export function settleHttpLinkBrowserOpen(
  opening: Promise<string | null | void>,
  reveal: { dispose: () => void },
  background: boolean,
  onComplete?: OpenHttpLinkOptions['onBrowserOpenComplete'],
  settle?: (outcome: HttpLinkAdmission) => void
): void {
  // A rejected open settles as failed; a no-op when the detailed outcome already settled it.
  const report = (error: unknown): void => {
    settle?.('failed')
    reportHttpLinkBrowserOpenFailure(error)
  }
  // Openers without a detailed outcome settle from their page id; after a detailed outcome this is a no-op.
  const settleFromPageId = (pageId: string | null | void): void =>
    settle?.(pageId ? 'admitted' : 'refused')
  if (onComplete) {
    void opening
      .then((pageId) => {
        settleFromPageId(pageId)
        onComplete({ pageId: pageId ?? null, background })
      })
      .catch(report)
      .finally(reveal.dispose)
    return
  }
  void opening.then(settleFromPageId).catch(report).finally(reveal.dispose)
}
