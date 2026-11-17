/**
 * Owner-side progress on one refresh intent. Freshness is proved only by a main-frame cross-document
 * navigation to the resource that started after the request and then committed.
 *
 * "After the request" is causal, never callback time. When the intent is recorded, one IPC round trip
 * to main fixes a baseline: main delivers a guest's events and invoke replies to this renderer on one
 * ordered channel, so every event it sent before the reply arrives before the baseline is taken. Each
 * main-frame start the renderer receives gets a page-level sequence number; a start numbered after the
 * baseline, or from a guest registered after the request, is a post-request navigation (the owner's own
 * action, or a newer one the user or page started, which wins). In-place navigations are not starts.
 */
export type ChangedFileRefreshPhase =
  /** Waiting to look at the guest (not ready yet, or a load just settled). */
  | 'evaluate'
  /** A main-frame load from before the request is in flight; act once it commits or fails. */
  | 'settling'
  /** A post-request navigation to the resource (ours or not) is under way; its commit proves freshness. */
  | 'proving'

export type ChangedFileRefreshTracker = {
  seq: number
  /** The guest the phase applies to; events from another guest are stale. */
  generation: number
  phase: ChangedFileRefreshPhase
  /** A post-request main-frame start to the resource was seen on this guest. */
  startedResource: boolean
  /** The owner already reloaded or navigated this guest for the intent; there is no second try. */
  acted: boolean
  /** The owner already recovered a dead guest for the intent; a second death ends it. */
  recovered: boolean
}

export type ChangedFileRefreshGuest = {
  generation: number
  /** Registered after the request, so each of its navigations started after it. */
  createdAfterRequest: boolean
  /** `missing`: a guest that attached and then died or failed; `not-ready`: alive or still attaching. */
  status: 'missing' | 'not-ready' | 'ready'
  /** The committed main-frame document is the requested resource. */
  showsResource: boolean
  loadingMainFrame: boolean
}

type GuestEvent = { generation: number; createdAfterRequest: boolean }

export type ChangedFileRefreshEvent =
  | { type: 'evaluate'; guest: ChangedFileRefreshGuest }
  /** did-start-navigation with isMainFrame && !isInPlace; `postRequest` per the baseline above. */
  | ({ type: 'main-start'; toResource: boolean; postRequest: boolean } & GuestEvent)
  /** did-navigate (main frame only). */
  | ({ type: 'main-commit'; toResource: boolean } & GuestEvent)
  /** Main-frame did-fail-load other than an abort (-3). */
  | ({ type: 'main-fail' } & GuestEvent)
  | { type: 'action-result'; result: 'issued' | 'not-ready' | 'failed' }

export type ChangedFileRefreshAction = 'reload' | 'navigate'

export type ChangedFileRefreshStepResult = {
  /** null: the intent is finished and must be cleared. */
  tracker: ChangedFileRefreshTracker | null
  /** Run through the page's own reload/recovery or navigation path, fenced by seq and generation. */
  action: ChangedFileRefreshAction | null
  outcome: 'satisfied' | 'dropped' | 'failed' | null
  /** Look at the guest again (a pre-request load failed). */
  reevaluate: boolean
}

function result(
  tracker: ChangedFileRefreshTracker | null,
  extra: Partial<Omit<ChangedFileRefreshStepResult, 'tracker'>> = {}
): ChangedFileRefreshStepResult {
  return { tracker, action: null, outcome: null, reevaluate: false, ...extra }
}

function evaluate(
  tracker: ChangedFileRefreshTracker,
  guest: ChangedFileRefreshGuest
): ChangedFileRefreshStepResult {
  const sameGuest = guest.generation === tracker.generation
  const base = {
    ...tracker,
    generation: guest.generation,
    startedResource: sameGuest && tracker.startedResource,
    acted: sameGuest && tracker.acted
  }
  if (guest.status === 'not-ready') {
    // Still attaching or before dom-ready: its first commit or readiness is judged then.
    return result({ ...base, phase: 'evaluate' })
  }
  if (guest.status === 'missing') {
    // One recovery through the page's reload entry; a guest that dies again ends the intent.
    return tracker.recovered
      ? result(null, { outcome: 'failed' })
      : result({ ...base, phase: 'proving', recovered: true }, { action: 'reload' })
  }
  if (guest.showsResource && (guest.createdAfterRequest || base.startedResource)) {
    return result(null, { outcome: 'satisfied' })
  }
  if (guest.loadingMainFrame) {
    return result({
      ...base,
      phase: guest.createdAfterRequest || base.startedResource ? 'proving' : 'settling'
    })
  }
  if (base.acted) {
    // Our action already ran on this guest and it settled without a proving commit.
    return result(null, { outcome: 'failed' })
  }
  // Not the resource (doc-preview A navigated to sibling B before the request): go back to A.
  return result(
    { ...base, phase: 'proving', acted: true },
    { action: guest.showsResource ? 'reload' : 'navigate' }
  )
}

export function changedFileRefreshStep(
  tracker: ChangedFileRefreshTracker,
  event: ChangedFileRefreshEvent
): ChangedFileRefreshStepResult {
  if (event.type === 'evaluate') {
    return evaluate(tracker, event.guest)
  }
  if (event.type === 'action-result') {
    if (event.result === 'failed') {
      return result(null, { outcome: 'failed' })
    }
    // Not ready: the action never ran, so it does not use up the one attempt.
    return result(
      event.result === 'not-ready' ? { ...tracker, phase: 'evaluate', acted: false } : tracker
    )
  }
  if (event.generation !== tracker.generation) {
    // Another guest's event; the owner re-evaluates on its own generation change.
    return result(tracker)
  }
  const { phase } = tracker
  if (event.type === 'main-start') {
    if (!event.postRequest) {
      // Delivered before the baseline: it began before the request and proves nothing.
      return result(tracker)
    }
    if (!event.toResource) {
      // A newer navigation elsewhere wins; a not-ready guest's own first load is judged at commit.
      return phase === 'evaluate' ? result(tracker) : result(null, { outcome: 'dropped' })
    }
    return result({ ...tracker, phase: 'proving', startedResource: true })
  }
  if (phase !== 'proving') {
    if (event.type === 'main-fail') {
      return result({ ...tracker, phase: 'evaluate' }, { reevaluate: true })
    }
    // A pre-request load committed: judge the document it left, even while subresources still load.
    return evaluate(tracker, {
      generation: event.generation,
      createdAfterRequest: event.createdAfterRequest,
      status: 'ready',
      showsResource: event.toResource,
      loadingMainFrame: false
    })
  }
  if (event.type === 'main-fail') {
    // One attempt only; the page's own error or Retry UI shows the failure.
    return result(null, { outcome: 'failed' })
  }
  if (!event.toResource) {
    return result(null, { outcome: 'dropped' })
  }
  return tracker.startedResource || event.createdAfterRequest
    ? result(null, { outcome: 'satisfied' })
    : result(tracker)
}
