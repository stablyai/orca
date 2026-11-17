import { useAppStore } from '@/store/index'
import {
  browserPageGuestIdentity,
  noteBrowserPageGuestAttached,
  subscribeBrowserPageMainFrameEvents
} from '@/components/browser-pane/host-guest/lifecycle/browser-page-main-frame-events'
import type {
  ChangedFilePageRefreshIntent,
  ChangedFilePageRefreshResource
} from './changed-file-page-refresh-intent'
import {
  changedFileRefreshStep,
  type ChangedFileRefreshEvent,
  type ChangedFileRefreshGuest,
  type ChangedFileRefreshStepResult,
  type ChangedFileRefreshTracker
} from './changed-file-page-refresh-step'

export type ChangedFileRefreshActionResult = 'issued' | 'not-ready' | 'failed'

/** The component that owns a page's guest; only it reloads, navigates or recovers that guest. */
export type ChangedFilePageRefreshOwner = {
  readWebview: () => Electron.WebviewTag | null
  /** The page record still names the resource: not converted, closed or retargeted. */
  pointsAtResource: (resource: ChangedFilePageRefreshResource) => boolean
  /** A committed main-frame URL is the resource's document. */
  isResourceUrl: (url: string, resource: ChangedFilePageRefreshResource) => boolean
  /** The owner shows the guest as failed or unavailable, so it needs recovery. */
  guestFailed?: () => boolean
  /** The page's own reload entry, which already recovers a dead guest. */
  reload: () => ChangedFileRefreshActionResult
  /** Loads the resource through the page's own navigation path. */
  navigate: (resource: ChangedFilePageRefreshResource) => ChangedFileRefreshActionResult
}

/** Same document: fragments are in-page positions, not documents. */
export function sameDocumentUrl(left: string, right: string): boolean {
  const normalize = (url: string): string => {
    try {
      const parsed = new URL(url)
      parsed.hash = ''
      return decodeURI(parsed.href)
    } catch {
      return url.split('#')[0] ?? url
    }
  }
  return normalize(left) === normalize(right)
}

function readGuest(
  webview: Electron.WebviewTag | null,
  intent: ChangedFilePageRefreshIntent,
  owner: ChangedFilePageRefreshOwner
): ChangedFileRefreshGuest {
  const identity = webview ? browserPageGuestIdentity(webview) : null
  const guest: ChangedFileRefreshGuest = {
    generation: identity?.generation ?? 0,
    createdAfterRequest: identity ? identity.registeredAt > intent.requestedAt : false,
    status: 'not-ready',
    showsResource: false,
    loadingMainFrame: false
  }
  // A failed preview (e.g. its grant could not be minted) may have no guest element at all.
  if (owner.guestFailed?.()) {
    return { ...guest, status: 'missing' }
  }
  if (!webview || !identity) {
    return guest
  }
  try {
    webview.getWebContentsId()
    noteBrowserPageGuestAttached(webview)
  } catch {
    // Not yet attached is not dead; only a guest that attached and then went away needs recovery.
    return { ...guest, status: identity.lifecycle === 'attaching' ? 'not-ready' : 'missing' }
  }
  if (identity.lifecycle === 'gone' || webview.isCrashed()) {
    return { ...guest, status: 'missing' }
  }
  try {
    const url = webview.getURL()
    return {
      ...guest,
      status: 'ready',
      showsResource: Boolean(url) && owner.isResourceUrl(url, intent.resource),
      loadingMainFrame: webview.isLoadingMainFrame()
    }
  } catch {
    // Alive but before dom-ready: it answers neither URL nor loading state yet.
    return guest
  }
}

export type ChangedFilePageRefreshDrive = {
  stop: () => void
  /** Look at the guest again after an owner-side change no guest event reports (e.g. a failed preview). */
  reevaluate: () => void
}

/** Drives one intent until it is satisfied, dropped or failed; it waits until the intent has its baseline. */
export function driveChangedFilePageRefresh(
  pageId: string,
  intent: ChangedFilePageRefreshIntent,
  owner: ChangedFilePageRefreshOwner
): ChangedFilePageRefreshDrive {
  const baselineSeq = intent.baselineSeq
  if (baselineSeq === undefined) {
    // The hook starts a new drive when the baseline lands on the intent.
    return { stop: () => {}, reevaluate: () => {} }
  }
  let tracker: ChangedFileRefreshTracker = {
    seq: intent.seq,
    generation: 0,
    phase: 'evaluate',
    startedResource: false,
    acted: false,
    recovered: false
  }
  let stopped = false
  let unsubscribe = (): void => {}
  const isCurrent = (): boolean =>
    !stopped && useAppStore.getState().changedFileRefreshByPageId[pageId]?.seq === intent.seq
  const finish = (): void => {
    stopped = true
    unsubscribe()
    useAppStore.getState().settleChangedFilePageRefresh(pageId, intent.seq)
  }
  const evaluateNow = (webview = owner.readWebview()): void =>
    run({ type: 'evaluate', guest: readGuest(webview, intent, owner) })

  const apply = (step: ChangedFileRefreshStepResult): void => {
    if (!isCurrent()) {
      return
    }
    if (!step.tracker) {
      finish()
      return
    }
    tracker = step.tracker
    if (step.action) {
      const webview = owner.readWebview()
      const generation = (webview && browserPageGuestIdentity(webview)?.generation) || 0
      if (generation !== tracker.generation) {
        // The guest changed since the decision; never act on the newer guest blindly.
        evaluateNow(webview)
        return
      }
      const result = step.action === 'reload' ? owner.reload() : owner.navigate(intent.resource)
      run({ type: 'action-result', result })
      return
    }
    if (step.reevaluate) {
      evaluateNow()
    }
  }
  const run = (event: ChangedFileRefreshEvent): void => {
    if (!owner.pointsAtResource(intent.resource)) {
      finish()
      return
    }
    apply(changedFileRefreshStep(tracker, event))
  }

  unsubscribe = subscribeBrowserPageMainFrameEvents(pageId, (webview, event) => {
    if (!isCurrent()) {
      return
    }
    const identity = browserPageGuestIdentity(webview)
    if (!identity) {
      return
    }
    const newGuest = identity.generation !== tracker.generation
    if (event.type === 'attached' || event.type === 'ready' || event.type === 'gone') {
      // A same-guest rebind mid-proof must not issue a second reload.
      if (newGuest || event.type === 'gone' || tracker.phase === 'evaluate') {
        evaluateNow(webview)
      }
      return
    }
    if (newGuest) {
      // A remount, remint or recovery replaced the guest: judge the new one before its event.
      evaluateNow(webview)
      if (!isCurrent()) {
        return
      }
    }
    const guestEvent = {
      generation: identity.generation,
      createdAfterRequest: identity.registeredAt > intent.requestedAt
    }
    if (event.type === 'fail') {
      run({ type: 'main-fail', ...guestEvent })
      return
    }
    const toResource = owner.isResourceUrl(event.url, intent.resource)
    run(
      event.type === 'start'
        ? {
            type: 'main-start',
            ...guestEvent,
            toResource,
            postRequest: event.seq > baselineSeq || guestEvent.createdAfterRequest
          }
        : { type: 'main-commit', ...guestEvent, toResource }
    )
  })
  evaluateNow()
  return {
    stop: () => {
      stopped = true
      unsubscribe()
    },
    reevaluate: () => {
      if (isCurrent()) {
        evaluateNow()
      }
    }
  }
}
