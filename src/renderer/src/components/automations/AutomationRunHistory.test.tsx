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
import { makeRun } from './automations-page-fixtures'

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
