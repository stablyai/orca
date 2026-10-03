// @vitest-environment happy-dom

/**
 * Coalescing folds consecutive identical refusals into one row, which is a large
 * improvement over the hundred rows it replaced — but the surviving row carries
 * the *first* occurrence's timestamp. Without the fold count and the latest
 * occurrence, a failure that is still happening every hour reads as one thing
 * that happened once, days ago.
 */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import { AutomationRunHistory } from './AutomationRunHistory'
import { WORKSPACE_ID, makeRun, makeRunUsage, makeWorktree } from './automations-page-fixtures'
import { VIRTUALIZER_STUB_WINDOW_SIZE } from './virtualizer-test-stub'

vi.mock('@tanstack/react-virtual', async () => {
  const { createVirtualizerStub } = await import('./virtualizer-test-stub')
  return { useVirtualizer: createVirtualizerStub() }
})

const roots: Root[] = []

const FIRST = Date.UTC(2026, 7, 9, 14, 0)
const LATEST = Date.UTC(2026, 7, 11, 9, 0)

async function render(overrides: Partial<AutomationRun>): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <AutomationRunHistory
        runs={[makeRun({ scheduledFor: FIRST, status: 'skipped_unavailable', ...overrides })]}
        automationId="a-1"
        worktreeMap={new Map()}
        onOpenRun={vi.fn()}
      />
    )
  })
  return container
}

async function renderFailure(
  onRecoverHistory: (action: 'retry' | 'reconnect' | 'update-server') => void
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <AutomationRunHistory
        runs={[]}
        automationId="a-1"
        worktreeMap={new Map()}
        notice={{ message: 'web-01 is not connected', recovery: 'reconnect', severity: 'failure' }}
        onRecoverHistory={onRecoverHistory}
        onOpenRun={vi.fn()}
      />
    )
  })
  return container
}

function occurrences(container: HTMLDivElement): string | null {
  return container.querySelector('[data-testid="automation-run-occurrences"]')?.textContent ?? null
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => {
    roots.splice(0).forEach((root) => root.unmount())
  })
  document.body.innerHTML = ''
})

describe('AutomationRunHistory occurrences', () => {
  it('says how many times a folded row stands for and when it last happened', async () => {
    const container = await render({ occurrenceCount: 12, lastOccurrenceAt: LATEST })

    expect(occurrences(container)).toContain('12 times')
    // The recency is the part that answers "is this over?" — the row's own date
    // is the first occurrence and cannot.
    expect(occurrences(container)).toContain('most recently')
    expect(occurrences(container)).not.toContain(String(LATEST))
  })

  it('adds nothing to a row that stands for a single occurrence', async () => {
    const container = await render({})

    expect(occurrences(container)).toBeNull()
  })

  it('adds nothing when a host reported a count of one', async () => {
    const container = await render({ occurrenceCount: 1 })

    expect(occurrences(container)).toBeNull()
  })

  it('still reports the count when an older host folded without a timestamp', async () => {
    const container = await render({ occurrenceCount: 4 })

    expect(occurrences(container)).toContain('4 times')
    expect(occurrences(container)).not.toContain('most recently')
  })
})

describe('AutomationRunHistory unanswered history', () => {
  it('states the failure instead of reporting zero runs', async () => {
    const container = await renderFailure(vi.fn())

    expect(container.textContent).not.toContain('No runs yet.')
    // "0 runs" is a count of something nobody managed to read.
    expect(container.textContent).not.toContain('0 runs')
    expect(container.textContent).toContain('Run history is unavailable from this host')
    expect(container.textContent).toContain('does not mean the automation failed or has no runs')
    expect(container.textContent).toContain('web-01 is not connected')
  })

  it('offers the recovery the failure named rather than a dead end', async () => {
    const onRecoverHistory = vi.fn()
    const container = await renderFailure(onRecoverHistory)
    const button = container.querySelector('[data-testid="automation-owner-conflict"] button')

    expect(button?.textContent).toBe('Reconnect')
    await act(async () => {
      ;(button as HTMLButtonElement).click()
    })

    expect(onRecoverHistory).toHaveBeenCalledWith('reconnect')
  })
})

describe('AutomationRunHistory virtualization', () => {
  async function renderRuns(runs: AutomationRun[]): Promise<HTMLDivElement> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    await act(async () => {
      root.render(
        <AutomationRunHistory
          runs={runs}
          automationId="a-1"
          worktreeMap={new Map()}
          onOpenRun={vi.fn()}
        />
      )
    })
    return container
  }

  async function pressArrow(key: 'ArrowDown' | 'ArrowUp', times: number): Promise<void> {
    for (let move = 0; move < times; move += 1) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      })
    }
  }

  function makeRuns(count: number): AutomationRun[] {
    return Array.from({ length: count }, (_, index) =>
      makeRun({ id: `run-${index}`, scheduledFor: FIRST + index })
    )
  }

  it('keeps a long history to a bounded number of mounted rows', async () => {
    const container = await renderRuns(makeRuns(5_000))

    expect(container.querySelectorAll('button[data-automation-run-id]').length).toBeLessThan(50)
    // The count above the table still speaks for the whole history, not the window.
    expect(container.textContent).toContain('5000 runs')
  })

  it('scrolls a selected row below the fold into the window and then focuses it', async () => {
    const container = await renderRuns(makeRuns(VIRTUALIZER_STUB_WINDOW_SIZE * 2))

    const belowFold = `run-${VIRTUALIZER_STUB_WINDOW_SIZE}`
    expect(container.querySelector(`[data-automation-run-id="${belowFold}"]`)).toBeNull()

    // Selection starts on the first row, so this many moves lands one row past the
    // window — the case where focus has to wait for the scroll to mount the row.
    await pressArrow('ArrowDown', VIRTUALIZER_STUB_WINDOW_SIZE)

    const selected = container.querySelector<HTMLButtonElement>(
      `[data-automation-run-id="${belowFold}"]`
    )
    expect(selected?.getAttribute('data-current')).toBe('true')
    expect(document.activeElement).toBe(selected)
    // The window moved rather than grew: the row it scrolled past is unmounted.
    expect(container.querySelector('[data-automation-run-id="run-0"]')).toBeNull()
  })

  it('scrolls a selected row above the fold back into the window and then focuses it', async () => {
    const container = await renderRuns(makeRuns(VIRTUALIZER_STUB_WINDOW_SIZE * 2))

    await pressArrow('ArrowDown', VIRTUALIZER_STUB_WINDOW_SIZE)
    expect(container.querySelector('[data-automation-run-id="run-0"]')).toBeNull()

    // Back to the top: the window now has to move the other way before focus can land.
    await pressArrow('ArrowUp', VIRTUALIZER_STUB_WINDOW_SIZE)

    const selected = container.querySelector<HTMLButtonElement>('[data-automation-run-id="run-0"]')
    expect(selected?.getAttribute('data-current')).toBe('true')
    expect(document.activeElement).toBe(selected)
  })
})

describe('AutomationRunHistory keyboard navigation', () => {
  it('navigates runs with ArrowDown and ArrowUp and opens on Enter', async () => {
    const onOpenRun = vi.fn()
    const run1 = makeRun({ id: 'run-1', scheduledFor: FIRST })
    const run2 = makeRun({ id: 'run-2', scheduledFor: LATEST })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <AutomationRunHistory
          runs={[run1, run2]}
          automationId="a-1"
          worktreeMap={new Map()}
          onOpenRun={onOpenRun}
        />
      )
    })

    const buttons = container.querySelectorAll<HTMLButtonElement>('button[data-automation-run-id]')
    expect(buttons[0].getAttribute('data-current')).toBe('true')
    expect(buttons[1].getAttribute('data-current')).toBe('false')

    // Press ArrowDown
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })

    expect(buttons[0].getAttribute('data-current')).toBe('false')
    expect(buttons[1].getAttribute('data-current')).toBe('true')

    // Press Enter to open selected run
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })

    expect(onOpenRun).toHaveBeenCalledWith(run2)

    // Press ArrowUp
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
      )
    })

    expect(buttons[0].getAttribute('data-current')).toBe('true')
    expect(buttons[1].getAttribute('data-current')).toBe('false')

    // Press Enter to open first run
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })

    expect(onOpenRun).toHaveBeenCalledWith(run1)
  })

  it('moves focus with the selection so Enter reaches the selected row, not the old one', async () => {
    const onOpenRun = vi.fn()
    const run1 = makeRun({ id: 'run-1', scheduledFor: FIRST })
    const run2 = makeRun({ id: 'run-2', scheduledFor: LATEST })

    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)

    await act(async () => {
      root.render(
        <AutomationRunHistory
          runs={[run1, run2]}
          automationId="a-1"
          worktreeMap={new Map()}
          onOpenRun={onOpenRun}
        />
      )
    })

    const buttons = container.querySelectorAll<HTMLButtonElement>('button[data-automation-run-id]')
    buttons[0].focus()
    expect(document.activeElement).toBe(buttons[0])

    await act(async () => {
      buttons[0].dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
      )
    })

    expect(buttons[1].getAttribute('data-current')).toBe('true')
    expect(document.activeElement).toBe(buttons[1])

    // Enter is passed through to the focused row, which must now be the selected one.
    ;(document.activeElement as HTMLButtonElement).click()
    expect(onOpenRun).toHaveBeenCalledTimes(1)
    expect(onOpenRun).toHaveBeenCalledWith(run2)
  })
})

describe('AutomationRunHistory row content', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    roots.push(root)
  })

  function renderHistory(props: {
    runs: AutomationRun[]
    automationId?: string
    worktreeMap?: ReadonlyMap<string, ReturnType<typeof makeWorktree>>
    onOpenRun?: (run: AutomationRun) => void
  }): void {
    act(() => {
      root.render(
        <AutomationRunHistory
          runs={props.runs}
          automationId={props.automationId ?? 'a-1'}
          worktreeMap={props.worktreeMap ?? new Map()}
          onOpenRun={props.onOpenRun ?? vi.fn()}
        />
      )
    })
  }

  function rows(): NodeListOf<HTMLButtonElement> {
    return container.querySelectorAll<HTMLButtonElement>('button[data-automation-run-id]')
  }

  it('reports spend and tokens a host actually measured', () => {
    renderHistory({
      runs: [
        makeRun({
          usage: makeRunUsage({ estimatedCostUsd: 1.5, totalTokens: 12_345 })
        })
      ]
    })

    expect(rows()[0].textContent).toContain('$1.50')
    expect(rows()[0].textContent).toContain('12k')
  })

  it('says n/a rather than zero when usage is unavailable', () => {
    renderHistory({ runs: [makeRun({ usage: null })] })

    // A run whose usage nobody could read has not been measured at $0.00.
    expect(rows()[0].textContent).toContain('n/a')
    expect(rows()[0].textContent).not.toContain('$0.00')
  })

  it('names the workspace a run is still attached to', () => {
    renderHistory({
      runs: [makeRun({ workspaceId: WORKSPACE_ID })],
      worktreeMap: new Map([[WORKSPACE_ID, makeWorktree({ displayName: 'nightly-check' })]])
    })

    expect(rows()[0].textContent).toContain('nightly-check')
  })

  it('keeps the remembered name of a workspace that is gone, and says it is gone', () => {
    renderHistory({
      runs: [makeRun({ workspaceId: WORKSPACE_ID, workspaceDisplayName: 'nightly-check' })],
      worktreeMap: new Map()
    })

    expect(rows()[0].textContent).toContain('nightly-check')
    expect(rows()[0].textContent).toContain('no longer available')
  })

  it('counts the whole history but only the completed runs as completed', () => {
    renderHistory({
      runs: [
        makeRun({ id: 'run-1', status: 'completed' }),
        makeRun({ id: 'run-2', status: 'dispatch_failed' }),
        makeRun({ id: 'run-3', status: 'completed' })
      ]
    })

    expect(container.textContent).toContain('3 runs · 2 completed')
  })

  it('says "1 run" rather than "1 runs"', () => {
    renderHistory({ runs: [makeRun()] })

    expect(container.textContent).toContain('1 run · 1 completed')
  })

  it('opens and selects the clicked run', () => {
    const onOpenRun = vi.fn()
    const second = makeRun({ id: 'run-2' })
    renderHistory({ runs: [makeRun({ id: 'run-1' }), second], onOpenRun })

    act(() => rows()[1].click())

    expect(onOpenRun).toHaveBeenCalledExactlyOnceWith(second)
    expect(rows()[1].getAttribute('data-current')).toBe('true')
    expect(rows()[0].getAttribute('data-current')).toBe('false')
  })

  it('drops a selection that belonged to the automation before this one', () => {
    const runs = [makeRun({ id: 'run-1' }), makeRun({ id: 'run-2' })]
    renderHistory({ runs, automationId: 'a-1' })
    act(() => rows()[1].click())

    expect(rows()[1].getAttribute('data-current')).toBe('true')

    // Same row IDs, different automation: carrying the old selection over would
    // highlight a row the user never picked.
    renderHistory({ runs, automationId: 'a-2' })

    expect(rows()[0].getAttribute('data-current')).toBe('true')
    expect(rows()[1].getAttribute('data-current')).toBe('false')
  })
})

describe('AutomationRunHistory keyboard navigation guards', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    roots.push(root)
  })

  async function pressEnter(): Promise<void> {
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    })
  }

  it('opens nothing while rows are on screen under an unanswered read', async () => {
    const onOpenRun = vi.fn()
    await act(async () => {
      root.render(
        <AutomationRunHistory
          runs={[makeRun({ id: 'run-1' })]}
          automationId="a-1"
          worktreeMap={new Map()}
          notice={{
            message: 'web-01 is not connected',
            recovery: 'reconnect',
            severity: 'failure'
          }}
          onOpenRun={onOpenRun}
        />
      )
    })

    await pressEnter()

    // The notice says these rows are not the host's answer, so Enter must not act
    // on them however many of them are still painted.
    expect(onOpenRun).not.toHaveBeenCalled()
  })

  it('follows the runs it was last given, not the ones it mounted with', async () => {
    const onOpenRun = vi.fn()
    const replacement = makeRun({ id: 'run-9', scheduledFor: LATEST })
    await act(async () => {
      root.render(
        <AutomationRunHistory
          runs={[makeRun({ id: 'run-1' })]}
          automationId="a-1"
          worktreeMap={new Map()}
          onOpenRun={onOpenRun}
        />
      )
    })
    // The listener subscribes once and reads the current runs through a ref; a
    // refreshed history has to reach it without a resubscribe.
    await act(async () => {
      root.render(
        <AutomationRunHistory
          runs={[replacement]}
          automationId="a-1"
          worktreeMap={new Map()}
          onOpenRun={onOpenRun}
        />
      )
    })

    await pressEnter()

    expect(onOpenRun).toHaveBeenCalledExactlyOnceWith(replacement)
  })
})
