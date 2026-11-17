import { describe, expect, it } from 'vitest'
import {
  changedFileRefreshStep,
  type ChangedFileRefreshEvent,
  type ChangedFileRefreshGuest,
  type ChangedFileRefreshTracker
} from './changed-file-page-refresh-step'

const start: ChangedFileRefreshTracker = {
  seq: 7,
  generation: 0,
  phase: 'evaluate',
  startedResource: false,
  acted: false,
  recovered: false
}

function guest(overrides: Partial<ChangedFileRefreshGuest> = {}): ChangedFileRefreshGuest {
  return {
    generation: 1,
    createdAfterRequest: false,
    status: 'ready',
    showsResource: true,
    loadingMainFrame: false,
    ...overrides
  }
}

const onGuest1 = { generation: 1, createdAfterRequest: false }

/** Runs events in order; actions are reported back as issued, as the owner does. */
function run(events: ChangedFileRefreshEvent[]): {
  actions: string[]
  outcome: string | null
  tracker: ChangedFileRefreshTracker | null
} {
  let tracker: ChangedFileRefreshTracker | null = start
  const actions: string[] = []
  let outcome: string | null = null
  for (const event of events) {
    if (!tracker) {
      break
    }
    const step = changedFileRefreshStep(tracker, event)
    tracker = step.tracker
    outcome = step.outcome ?? outcome
    if (step.action) {
      actions.push(step.action)
      tracker = tracker
        ? changedFileRefreshStep(tracker, { type: 'action-result', result: 'issued' }).tracker
        : null
    }
    if (step.reevaluate) {
      actions.push('reevaluate')
    }
  }
  return { actions, outcome, tracker }
}

describe('changedFileRefreshStep', () => {
  it('reloads an idle page that shows the resource once', () => {
    const result = run([{ type: 'evaluate', guest: guest() }])
    expect(result.actions).toEqual(['reload'])
    expect(result.tracker?.phase).toBe('proving')
  })

  it('is satisfied by its reload starting and committing to the resource', () => {
    const result = run([
      { type: 'evaluate', guest: guest() },
      { type: 'main-start', postRequest: true, toResource: true, ...onGuest1 },
      { type: 'main-commit', toResource: true, ...onGuest1 }
    ])
    expect(result).toMatchObject({ actions: ['reload'], outcome: 'satisfied', tracker: null })
  })

  it('reloads after a load that started before the request commits', () => {
    const result = run([
      { type: 'evaluate', guest: guest({ loadingMainFrame: true }) },
      // Delivered before the baseline: it proves nothing.
      { type: 'main-start', postRequest: false, toResource: true, ...onGuest1 },
      { type: 'main-commit', toResource: true, ...onGuest1 }
    ])
    expect(result.actions).toEqual(['reload'])
    expect(result.tracker?.phase).toBe('proving')
  })

  it('is satisfied without action by a newer guest that started and committed the resource', () => {
    const fresh = { generation: 2, createdAfterRequest: true }
    const result = run([
      { type: 'evaluate', guest: guest({ ...fresh, status: 'not-ready' }) },
      { type: 'main-start', postRequest: true, toResource: true, ...fresh },
      { type: 'main-commit', toResource: true, ...fresh }
    ])
    expect(result).toMatchObject({ actions: [], outcome: 'satisfied', tracker: null })
  })

  it('is not satisfied by a commit whose start was not seen after the request', () => {
    const result = run([
      { type: 'evaluate', guest: guest() },
      { type: 'main-commit', toResource: true, ...onGuest1 }
    ])
    expect(result.outcome).toBeNull()
    expect(result.tracker?.phase).toBe('proving')
  })

  it('waits while the guest is not ready, then acts on its first commit', () => {
    const result = run([
      { type: 'evaluate', guest: guest({ status: 'not-ready' }) },
      { type: 'main-commit', toResource: true, ...onGuest1 }
    ])
    expect(result.actions).toEqual(['reload'])
  })

  it('keeps the intent pending when the reload reports not-ready', () => {
    const decided = changedFileRefreshStep(start, { type: 'evaluate', guest: guest() })
    const pending = changedFileRefreshStep(decided.tracker!, {
      type: 'action-result',
      result: 'not-ready'
    })
    expect(pending.tracker?.phase).toBe('evaluate')
    expect(
      changedFileRefreshStep(pending.tracker!, { type: 'evaluate', guest: guest() }).action
    ).toBe('reload')
  })

  it('routes a dead guest through the reload entry, which recovers it', () => {
    expect(run([{ type: 'evaluate', guest: guest({ status: 'missing' }) }]).actions).toEqual([
      'reload'
    ])
  })

  it('recovers a replacement guest that dies once, and fails if it dies again', () => {
    const replacement = guest({ generation: 2, createdAfterRequest: true, status: 'missing' })
    const first = changedFileRefreshStep(start, { type: 'evaluate', guest: replacement })
    expect(first).toMatchObject({ action: 'reload', tracker: { recovered: true } })
    const again = changedFileRefreshStep(first.tracker!, {
      type: 'evaluate',
      guest: { ...replacement, generation: 3 }
    })
    expect(again).toMatchObject({ tracker: null, outcome: 'failed', action: null })
  })

  it('waits for a guest that is still attaching instead of recovering it', () => {
    const attaching = guest({ generation: 2, createdAfterRequest: true, status: 'not-ready' })
    expect(changedFileRefreshStep(start, { type: 'evaluate', guest: attaching })).toMatchObject({
      action: null,
      tracker: { phase: 'evaluate' }
    })
  })

  it('does not reload a guest twice when it settles without the proving commit', () => {
    const decided = run([{ type: 'evaluate', guest: guest() }])
    expect(
      changedFileRefreshStep(decided.tracker!, { type: 'evaluate', guest: guest() })
    ).toMatchObject({ tracker: null, outcome: 'failed', action: null })
  })

  it('is satisfied when a remounted guest first loads the resource after the request', () => {
    const fresh = guest({ generation: 2, createdAfterRequest: true })
    expect(run([{ type: 'evaluate', guest: fresh }])).toMatchObject({
      actions: [],
      outcome: 'satisfied'
    })
  })

  it('navigates back to the resource when the guest shows a sibling document, not reload', () => {
    const result = run([
      { type: 'evaluate', guest: guest({ showsResource: false }) },
      { type: 'main-start', postRequest: true, toResource: true, ...onGuest1 },
      { type: 'main-commit', toResource: true, ...onGuest1 }
    ])
    expect(result).toMatchObject({ actions: ['navigate'], outcome: 'satisfied' })
  })

  it('ignores a start delivered before the baseline, even to another document', () => {
    const settling = run([{ type: 'evaluate', guest: guest({ loadingMainFrame: true }) }])
    expect(
      changedFileRefreshStep(settling.tracker!, {
        type: 'main-start',
        toResource: false,
        postRequest: false,
        ...onGuest1
      })
    ).toMatchObject({ outcome: null, tracker: settling.tracker })
  })

  it('drops the intent when a post-request navigation elsewhere starts while a pre-request load settles', () => {
    const result = run([
      { type: 'evaluate', guest: guest({ loadingMainFrame: true }) },
      { type: 'main-start', toResource: false, postRequest: true, ...onGuest1 }
    ])
    expect(result).toMatchObject({ actions: [], outcome: 'dropped', tracker: null })
  })

  it('is satisfied without action by a post-request load of the resource it did not issue', () => {
    const result = run([
      { type: 'evaluate', guest: guest({ loadingMainFrame: true }) },
      { type: 'main-start', toResource: true, postRequest: true, ...onGuest1 },
      { type: 'main-commit', toResource: true, ...onGuest1 }
    ])
    expect(result).toMatchObject({ actions: [], outcome: 'satisfied', tracker: null })
  })

  it('drops the intent when the user navigates elsewhere while it is pending', () => {
    const result = run([
      { type: 'evaluate', guest: guest() },
      { type: 'main-start', postRequest: true, toResource: false, ...onGuest1 }
    ])
    expect(result).toMatchObject({ outcome: 'dropped', tracker: null })
  })

  it('ignores a replaced guest event and judges the new guest instead', () => {
    const decided = run([{ type: 'evaluate', guest: guest() }])
    const stale = changedFileRefreshStep(decided.tracker!, {
      type: 'main-commit',
      toResource: true,
      generation: 0,
      createdAfterRequest: false
    })
    expect(stale).toMatchObject({ action: null, outcome: null, tracker: decided.tracker })
    const renewed = changedFileRefreshStep(decided.tracker!, {
      type: 'evaluate',
      guest: guest({
        generation: 3,
        createdAfterRequest: true,
        loadingMainFrame: true,
        showsResource: false
      })
    })
    expect(renewed.tracker).toMatchObject({ generation: 3, phase: 'proving' })
  })

  it('clears after one failed main-frame attempt, with no retry', () => {
    const result = run([
      { type: 'evaluate', guest: guest() },
      { type: 'main-start', postRequest: true, toResource: true, ...onGuest1 },
      { type: 'main-fail', ...onGuest1 }
    ])
    expect(result).toMatchObject({ actions: ['reload'], outcome: 'failed', tracker: null })
  })

  it('clears when the reload itself fails', () => {
    const decided = changedFileRefreshStep(start, { type: 'evaluate', guest: guest() })
    expect(
      changedFileRefreshStep(decided.tracker!, { type: 'action-result', result: 'failed' })
    ).toMatchObject({ tracker: null, outcome: 'failed' })
  })
})
