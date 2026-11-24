import { describe, expect, it } from 'vitest'
import type { Tab } from './tab-types'
import type { WorkerTabStamp } from '../../orchestration/workers/worker-tab-stamp'
import {
  canMoveLeafIntoTab,
  isMixedWorkerTab,
  isWorkerTabFolded,
  pickVisibleLandingTabId,
  type WorkerTabFoldContext
} from './worker-tab-visibility'

const coordinator = { kind: 'pane', paneKey: 'coord-tab:coord-leaf' } as const

function stamp(dispatchId: string, workerLeafId?: string): WorkerTabStamp {
  return {
    origin: {
      runId: 'run-1',
      dispatchId,
      taskId: `task-${dispatchId}`,
      parent: coordinator,
      coordinator,
      ...(workerLeafId ? { workerLeafId } : {})
    }
  }
}

function workerTab(id: string, workerLeafId = `${id}-leaf`): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    workerTab: stamp(`dispatch-${id}`, workerLeafId)
  }
}

function context(overrides: Partial<WorkerTabFoldContext> = {}): WorkerTabFoldContext {
  return {
    mode: 'open-when-clicked',
    peekTabId: null,
    activeId: null,
    choice: () => undefined,
    leafIds: (tabId) => [`${tabId}-leaf`],
    inGrace: () => false,
    reachable: new Set(['w1']),
    failOpenShown: new Set(),
    ...overrides
  }
}

describe('isWorkerTabFolded', () => {
  const tab = workerTab('w1')

  it('folds a reachable automatic worker', () => {
    expect(isWorkerTabFolded(tab, context())).toBe(true)
  })

  it('shows the active tab and the peek', () => {
    expect(isWorkerTabFolded(tab, context({ activeId: 'w1' }))).toBe(false)
    expect(isWorkerTabFolded(tab, context({ peekTabId: 'w1' }))).toBe(false)
  })

  it('shows a kept worker and everything in Always open', () => {
    expect(isWorkerTabFolded(tab, context({ choice: () => 'kept' }))).toBe(false)
    expect(isWorkerTabFolded(tab, context({ mode: 'always-open' }))).toBe(false)
  })

  it('shows an unreachable automatic worker but folds a deliberately hidden one', () => {
    expect(isWorkerTabFolded(tab, context({ reachable: new Set() }))).toBe(false)
    expect(isWorkerTabFolded(tab, context({ reachable: new Set(), choice: () => 'hidden' }))).toBe(
      true
    )
  })

  it('keeps a fail-open worker shown until it is hidden', () => {
    expect(isWorkerTabFolded(tab, context({ failOpenShown: new Set(['w1']) }))).toBe(false)
  })

  it('folds during grace before its first row exists', () => {
    expect(isWorkerTabFolded(tab, context({ reachable: new Set(), inGrace: () => true }))).toBe(
      true
    )
  })

  it('never folds a tab holding a user leaf', () => {
    const mixed = context({ leafIds: () => ['w1-leaf', 'user-leaf'], choice: () => 'hidden' })
    expect(isWorkerTabFolded(tab, mixed)).toBe(false)
    expect(isMixedWorkerTab(tab, ['w1-leaf', 'user-leaf'])).toBe(true)
  })

  it('never folds an unstamped tab', () => {
    const { workerTab: _stamp, ...plain } = tab
    expect(isWorkerTabFolded(plain, context({ choice: () => 'hidden' }))).toBe(false)
  })
})

describe('pickVisibleLandingTabId', () => {
  it('prefers the most recent visible tab, then the first visible, then none', () => {
    const folded = new Set(['w1', 'w2'])
    expect(pickVisibleLandingTabId(['a', 'w1', 'b'], ['b', 'w1'], folded)).toBe('b')
    expect(pickVisibleLandingTabId(['w1', 'a'], ['w1'], folded)).toBe('a')
    expect(pickVisibleLandingTabId(['w1', 'w2'], ['w2'], folded)).toBeNull()
  })

  it('never lands on the tab being hidden', () => {
    expect(pickVisibleLandingTabId(['a', 'b'], ['a', 'b'], new Set(), 'b')).toBe('a')
  })
})

describe('canMoveLeafIntoTab', () => {
  it("refuses a worker leaf into another worker's tab", () => {
    expect(canMoveLeafIntoTab(workerTab('w1'), 'w1-leaf', workerTab('w2'))).toBe(false)
  })

  it('allows a worker leaf into an unstamped tab and any user leaf anywhere', () => {
    expect(canMoveLeafIntoTab(workerTab('w1'), 'w1-leaf', { workerTab: undefined })).toBe(true)
    expect(canMoveLeafIntoTab(workerTab('w1'), 'user-leaf', workerTab('w2'))).toBe(true)
  })
})
