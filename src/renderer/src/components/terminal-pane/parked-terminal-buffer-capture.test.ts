// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RepoConnection } from '../../../../shared/workspace-session-terminal-buffers'
import {
  beginParkedCapturePass,
  captureParkedTerminalBuffers,
  enqueueParkedTerminalCapture,
  whenParkedCaptureSettles
} from './parked-terminal-buffer-capture'
import { shutdownBufferCaptures } from './shutdown-buffer-captures'
import { captureTerminalShutdownLayoutYielding } from './terminal-shutdown-layout-capture'

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: vi.fn()
}))

const LOCAL_REPO: RepoConnection = {
  id: 'repo',
  connectionId: null,
  executionHostId: 'local'
}
const SSH_REPO: RepoConnection = {
  id: 'repo',
  connectionId: 'conn-1',
  executionHostId: null
}
const WORKTREE_ID = 'repo::/repo/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111' as const
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222' as const
const CURSOR_HOME = '\x1b[1;1H'

function mockSplitContainer(): HTMLDivElement {
  const first = document.createElement('div')
  first.className = 'pane'
  first.dataset.paneId = '1'
  first.dataset.leafId = LEAF_ID
  first.style.flex = '1'
  const second = document.createElement('div')
  second.className = 'pane'
  second.dataset.paneId = '2'
  second.dataset.leafId = LEAF_ID_2
  second.style.flex = '1'
  const split = document.createElement('div')
  split.className = 'pane-split'
  split.append(first, second)
  const root = document.createElement('div')
  root.append(split)
  return root
}

function mockPaneTerminal(scrollback: number): {
  options: { scrollback: number }
  cols: number
  rows: number
  buffer: { active: { cursorX: number; cursorY: number } }
  write: (data: string, callback?: () => void) => void
} {
  return {
    options: { scrollback },
    cols: 80,
    rows: 24,
    buffer: { active: { cursorX: 0, cursorY: 0 } },
    write(_data: string, callback?: () => void) {
      callback?.()
    }
  }
}

afterEach(() => {
  shutdownBufferCaptures.clear()
  vi.useRealTimers()
})

describe('captureParkedTerminalBuffers', () => {
  it('skips the capture for a local-repo worktree so a stored buffer survives the park', () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)

    const captured = captureParkedTerminalBuffers({
      worktreeId: WORKTREE_ID,
      tabIds: ['tab-1'],
      repos: [LOCAL_REPO]
    })

    expect(captured).toBe(true)
    expect(capture).not.toHaveBeenCalled()
  })

  it('captures a remote worktree tab without local buffers and reports full coverage', async () => {
    const capture = vi.fn()
    shutdownBufferCaptures.set('tab-1', capture)

    await expect(
      captureParkedTerminalBuffers({
        worktreeId: WORKTREE_ID,
        tabIds: ['tab-1'],
        repos: [SSH_REPO]
      })
    ).resolves.toBe(true)
    expect(capture).toHaveBeenCalledWith({ includeLocalBuffers: false, yieldBetweenPanes: true })
  })

  it('reports an incomplete episode when a tab has no registered capture', async () => {
    shutdownBufferCaptures.set('tab-1', vi.fn())

    await expect(
      captureParkedTerminalBuffers({
        worktreeId: WORKTREE_ID,
        tabIds: ['tab-1', 'tab-mid-remount'],
        repos: [SSH_REPO]
      })
    ).resolves.toBe(false)
  })

  it('does not serialize every pane on one synchronous parking stack', async () => {
    vi.useFakeTimers()
    const firstSerialize = vi.fn(() => 'first-scrollback')
    const secondSerialize = vi.fn(() => 'second-scrollback')
    const firstPane = {
      id: 1,
      leafId: LEAF_ID,
      terminal: mockPaneTerminal(1_000),
      serializeAddon: { serialize: firstSerialize }
    }
    const secondPane = {
      id: 2,
      leafId: LEAF_ID_2,
      terminal: mockPaneTerminal(1_000),
      serializeAddon: { serialize: secondSerialize }
    }
    const container = mockSplitContainer()
    const manager = {
      getPanes: () => [firstPane, secondPane],
      getActivePane: () => firstPane
    }
    shutdownBufferCaptures.set('tab-1', (options) => {
      if (!options?.yieldBetweenPanes) {
        throw new Error('parking capture must yield between panes')
      }
      return captureTerminalShutdownLayoutYielding({
        manager,
        container,
        expandedPaneId: null,
        paneTransports: new Map(),
        paneTitlesByPaneId: {},
        existingLayout: undefined
      }).then((layout) => {
        expect(layout.buffersByLeafId).toEqual({
          [LEAF_ID]: `first-scrollback${CURSOR_HOME}`,
          [LEAF_ID_2]: `second-scrollback${CURSOR_HOME}`
        })
      })
    })

    const pending = captureParkedTerminalBuffers({
      worktreeId: WORKTREE_ID,
      tabIds: ['tab-1'],
      repos: [SSH_REPO]
    })

    expect(pending).toBeInstanceOf(Promise)
    expect(firstSerialize).toHaveBeenCalled()
    expect(secondSerialize).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(0)
    await expect(pending).resolves.toBe(true)
    expect(secondSerialize).toHaveBeenCalled()
  })
})

describe('ordinary-park capture wiring', () => {
  it('the parking pass captures ordinary parks through the yielding helper', () => {
    const parkingSource = readFileSync(join(__dirname, '../use-terminal-parking-pass.ts'), 'utf8')
    const coldParkSource = readFileSync(
      join(__dirname, './use-terminal-tab-cold-parking.ts'),
      'utf8'
    )
    const titleEffectsSource = readFileSync(
      join(__dirname, './use-terminal-pane-title-effects.ts'),
      'utf8'
    )

    expect(parkingSource).toContain('captureParkedTerminalBuffers')
    expect(parkingSource).toContain('enqueueParkedTerminalCapture')
    expect(parkingSource).toContain('whenParkedCaptureSettles')
    expect(parkingSource).toContain('beginParkedCapturePass')
    expect(parkingSource).toContain('passGuard.isCurrent')
    expect(coldParkSource).toContain('scheduleNewlyParkedTerminalTabCapture')
    expect(titleEffectsSource).toContain('beginParkedCapturePass')
    expect(titleEffectsSource).toContain('readExistingLayout')
  })
})

describe('parked capture pass generation', () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((next) => {
      resolve = next
    })
    return { promise, resolve }
  }

  it('keeps the newer pass when an older overlapping capture settles last', async () => {
    const generation = { current: 0 }
    const commits: string[] = []
    const capturedParked = new Set<string>()

    const older = beginParkedCapturePass(generation)
    const olderCapture = deferred<boolean>()
    const olderPending: Promise<unknown>[] = []
    enqueueParkedTerminalCapture(
      olderCapture.promise,
      () => {
        capturedParked.add('wt-old')
      },
      olderPending,
      older.isCurrent
    )
    whenParkedCaptureSettles(
      Promise.all(olderPending),
      () => {
        commits.push('old')
      },
      older.isCurrent
    )

    const newer = beginParkedCapturePass(generation)
    const newerCapture = deferred<boolean>()
    const newerPending: Promise<unknown>[] = []
    enqueueParkedTerminalCapture(
      newerCapture.promise,
      () => {
        capturedParked.add('wt-new')
      },
      newerPending,
      newer.isCurrent
    )
    whenParkedCaptureSettles(
      Promise.all(newerPending),
      () => {
        commits.push('new')
      },
      newer.isCurrent
    )

    newerCapture.resolve(true)
    await vi.waitFor(() => expect(commits).toEqual(['new']))
    olderCapture.resolve(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(commits).toEqual(['new'])
    expect(capturedParked).toEqual(new Set(['wt-new']))
  })
})
