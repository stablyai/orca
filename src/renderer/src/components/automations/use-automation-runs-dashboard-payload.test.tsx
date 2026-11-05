// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import { makeAutomationListRow, makeRun } from './automations-page-fixtures'
import * as dispatch from './automation-row-action-dispatch'
import { useAutomationRunsDashboard } from './use-automation-runs-dashboard'
import {
  useSelectedAutomationRunHistory,
  type SelectedAutomationRunHistoryOutcome
} from './use-selected-automation-run-history'

vi.mock('./automation-row-action-dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof dispatch>()),
  dispatchAutomationRunHistoryPage: vi.fn(),
  dispatchAutomationRunHistory: vi.fn()
}))

const pageSpy = vi.mocked(dispatch.dispatchAutomationRunHistoryPage)
const selectedSpy = vi.mocked(dispatch.dispatchAutomationRunHistory)
const row = makeAutomationListRow()
const rows = [row]
const context = { capturedOwners: new Map(), authority: { kind: 'desktop' as const } }
const legacyTarget = () => null
const authorityForRow = () => ({ kind: 'desktop' as const })
type DashboardResult = ReturnType<typeof useAutomationRunsDashboard>
type PageResult = Awaited<ReturnType<typeof dispatch.dispatchAutomationRunHistoryPage>>

let root: Root
let container: HTMLDivElement
let latest: DashboardResult | null = null
let selected: SelectedAutomationRunHistoryOutcome | null = null
const frames: { enabled: boolean; ids: string[]; loading: boolean }[] = []

function recordSelected(outcome: SelectedAutomationRunHistoryOutcome): void {
  selected = outcome
}

function Harness({ enabled, detail = false }: { enabled: boolean; detail?: boolean }): null {
  latest = useAutomationRunsDashboard({
    enabled,
    rows,
    context,
    legacyTarget,
    authorityForRow,
    reloadToken: 0
  })
  useSelectedAutomationRunHistory({
    selected: detail ? row : null,
    context,
    legacyTarget,
    navigation: null,
    reloadToken: 0,
    onSettled: recordSelected
  })
  frames.push({
    enabled,
    ids: latest.entries.map((entry) => entry.run.id),
    loading: latest.loading
  })
  return null
}

async function render(enabled: boolean, detail: boolean = false): Promise<void> {
  await act(async () => {
    root.render(<Harness enabled={enabled} detail={detail} />)
  })
}

function entries(): DashboardResult['entries'] {
  if (!latest) {
    throw new Error('Expected the mounted dashboard result')
  }
  return latest.entries
}

function fullRun(id: string, scheduledFor: number = 10): AutomationRun {
  return makeRun({
    id,
    scheduledFor,
    title: `Run ${id}`,
    trigger: 'manual',
    outputSnapshot: {
      format: 'plain_text',
      content: `Terminal output for ${id}\n`,
      capturedAt: 20,
      truncated: false
    }
  })
}

async function readRetiredPage() {
  const run = fullRun('head')
  const snapshot = run.outputSnapshot
  if (!snapshot) {
    throw new Error('Expected the full run fixture output')
  }
  const retired = { run: new WeakRef(run), snapshot: new WeakRef(snapshot) }
  pageSpy.mockResolvedValueOnce({ ok: true, value: { runs: [run], nextCursor: 'next-page' } })
  await render(true)
  pageSpy.mockReset()
  return retired
}

async function collectRetiredReply(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function pendingPage() {
  let complete: ((result: PageResult) => void) | null = null
  const promise = new Promise<PageResult>((resolve) => {
    complete = resolve
  })
  return {
    promise,
    resolve: (result: PageResult): void => {
      if (!complete) {
        throw new Error('Expected a pending history request')
      }
      complete(result)
    }
  }
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  frames.length = 0
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  latest = null
  selected = null
  frames.length = 0
  pageSpy.mockReset()
  selectedSpy.mockReset()
})

describe('automation dashboard run payload ownership', () => {
  it('releases full history replies while their dashboard metadata remains live', async () => {
    const retired = await readRetiredPage()
    expect(entries()[0]?.run).toMatchObject({
      id: 'head',
      title: 'Run head',
      scheduledFor: 10,
      status: 'completed',
      trigger: 'manual'
    })
    expect(latest?.nextCursors.get(row.key)).toBe('next-page')

    await collectRetiredReply()

    expect(retired.run.deref()).toBeUndefined()
    expect(retired.snapshot.deref()).toBeUndefined()
    expect(Object.keys(entries()[0]?.run ?? {}).sort()).toEqual([
      'id',
      'scheduledFor',
      'status',
      'title',
      'trigger'
    ])
    expect(entries().map((entry) => entry.run.id)).toEqual(['head'])
  })

  it('keeps the first re-entry frame and re-asks the head without retaining closed outputs', async () => {
    const retired = await readRetiredPage()
    await render(false)
    expect(entries()).toEqual([])
    await collectRetiredReply()
    expect(retired.run.deref()).toBeUndefined()
    expect(retired.snapshot.deref()).toBeUndefined()

    const pending = pendingPage()
    pageSpy.mockReturnValueOnce(pending.promise)
    frames.length = 0
    await render(true)
    expect(frames[0]).toEqual({ enabled: true, ids: ['head'], loading: false })
    expect(entries()).toEqual([])
    expect(latest?.loading).toBe(true)
    expect(pageSpy.mock.calls[0]?.[2].cursor).toBeUndefined()
    await act(async () => {
      pending.resolve({ ok: true, value: { runs: [fullRun('fresh')], nextCursor: null } })
    })
    expect(entries().map((entry) => entry.run.id)).toEqual(['fresh'])
  })

  it('preserves the first duplicate, chronological order and cursor retirement when paging', async () => {
    pageSpy
      .mockResolvedValueOnce({
        ok: true,
        value: { runs: [fullRun('head', 20)], nextCursor: 'next-page' }
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { runs: [fullRun('head', 30), fullRun('older', 10)], nextCursor: null }
      })
    await render(true)
    await act(async () => latest?.loadMore())

    expect(entries().map((entry) => [entry.run.id, entry.run.scheduledFor])).toEqual([
      ['head', 20],
      ['older', 10]
    ])
    expect(pageSpy.mock.calls[1]?.[2].cursor).toBe('next-page')
    expect(latest?.hasMore).toBe(false)
  })

  it('ignores a closed request that finishes after a fresh re-entry', async () => {
    const pending = pendingPage()
    pageSpy.mockReturnValueOnce(pending.promise).mockResolvedValueOnce({
      ok: true,
      value: { runs: [fullRun('fresh')], nextCursor: null }
    })
    await render(true)
    await render(false)
    await render(true)
    await act(async () => {
      pending.resolve({ ok: true, value: { runs: [fullRun('obsolete')], nextCursor: 'stale' } })
    })

    expect(entries().map((entry) => entry.run.id)).toEqual(['fresh'])
    expect(latest?.hasMore).toBe(false)
  })

  it('keeps the complete independently fetched selected history for run details', async () => {
    const run = fullRun('head')
    pageSpy.mockResolvedValueOnce({ ok: true, value: { runs: [run], nextCursor: null } })
    selectedSpy.mockResolvedValueOnce({ ok: true, value: [run] })
    await render(true, true)

    expect(entries()[0]?.run.id).toBe(run.id)
    expect(selected?.runs[0]).toBe(run)
    expect(selected?.runs[0]?.outputSnapshot?.content).toBe('Terminal output for head\n')
    expect(selectedSpy).toHaveBeenCalledOnce()
  })
})
