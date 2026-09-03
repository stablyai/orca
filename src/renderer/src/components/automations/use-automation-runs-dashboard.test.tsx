// @vitest-environment happy-dom

import { act, useCallback } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import type { AutomationRunsPage } from '../../../../shared/automations-types'
import type { AutomationHostTarget } from './automation-host-client'
import { makeAutomationListRow, makeRun } from './automations-page-fixtures'
import * as dispatch from './automation-row-action-dispatch'
import { useAutomationRunsDashboard } from './use-automation-runs-dashboard'

vi.mock('./automation-row-action-dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof dispatch>()),
  dispatchAutomationRunHistoryPage: vi.fn()
}))

const historySpy = vi.mocked(dispatch.dispatchAutomationRunHistoryPage)

const PAGES: Record<string, AutomationRunsPage> = {
  head: { runs: [makeRun({ id: 'run-2', createdAt: 2 })], nextCursor: '2:run-2' },
  '2:run-2': { runs: [makeRun({ id: 'run-1', createdAt: 1 })], nextCursor: null }
}

const row = makeAutomationListRow()
const rows = [row]
const context = { capturedOwners: new Map(), authority: { kind: 'desktop' as const } }

type DashboardResult = ReturnType<typeof useAutomationRunsDashboard>

let container: HTMLDivElement
let root: Root
let latest: DashboardResult | null = null

type HarnessProps = {
  enabled: boolean
  authority?: AutomationAuthorityRef
  target?: AutomationHostTarget | null
}

function Harness({ enabled, authority, target }: HarnessProps): null {
  latest = useAutomationRunsDashboard({
    enabled,
    rows,
    context,
    legacyTarget: useCallback(() => target ?? null, [target]),
    authorityForRow: useCallback(() => authority ?? { kind: 'desktop' }, [authority]),
    reloadToken: 0
  })
  return null
}

async function render(enabled: boolean, props: Omit<HarnessProps, 'enabled'> = {}): Promise<void> {
  await act(async () => {
    root.render(<Harness enabled={enabled} {...props} />)
  })
}

beforeEach(() => {
  historySpy.mockImplementation(async (_context, _row, options) => ({
    ok: true,
    value: PAGES[options.cursor ?? 'head']
  }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  latest = null
  historySpy.mockReset()
})

describe('useAutomationRunsDashboard', () => {
  it('appends the next page when load more fires', async () => {
    await render(true)
    expect(latest?.entries.map((entry) => entry.run.id)).toEqual(['run-2'])

    await act(async () => latest?.loadMore())

    expect(latest?.entries.map((entry) => entry.run.id)).toEqual(['run-2', 'run-1'])
    expect(historySpy.mock.calls.at(-1)?.[2].cursor).toBe('2:run-2')
  })

  it('keeps the cursor when a load more fails so the page stays retryable', async () => {
    await render(true)
    historySpy.mockImplementationOnce(async () => ({
      ok: false,
      notice: { message: 'offline', recovery: null, severity: 'failure' }
    }))

    await act(async () => latest?.loadMore())
    expect(latest?.entries.map((entry) => entry.run.id)).toEqual(['run-2'])
    expect(latest?.hasMore).toBe(true)

    await act(async () => latest?.loadMore())

    expect(historySpy.mock.calls.at(-1)?.[2].cursor).toBe('2:run-2')
    expect(latest?.entries.map((entry) => entry.run.id)).toEqual(['run-2', 'run-1'])
  })

  it('refetches the head when the view is re-entered after a load more', async () => {
    await render(true)
    await act(async () => latest?.loadMore())
    await render(false)
    historySpy.mockClear()

    await render(true)

    expect(historySpy.mock.calls.at(-1)?.[2].cursor).toBeUndefined()
    expect(latest?.entries.map((entry) => entry.run.id)).toEqual(['run-2'])
  })

  it('reloads from the head when the authority is re-paired', async () => {
    const paired = (pairingRevision: number): AutomationAuthorityRef => ({
      kind: 'runtime',
      environmentId: 'env-1',
      pairingRevision
    })
    await render(true, { authority: paired(1) })
    await act(async () => latest?.loadMore())
    expect(latest?.entries).toHaveLength(2)
    historySpy.mockClear()

    await render(true, { authority: paired(2) })

    expect(historySpy.mock.calls.at(-1)?.[2].cursor).toBeUndefined()
    expect(latest?.entries.map((entry) => entry.run.id)).toEqual(['run-2'])
  })

  it('reloads from the head when an uncaptured row moves to another fallback target', async () => {
    await render(true, { target: { kind: 'local' } })
    await act(async () => latest?.loadMore())
    expect(latest?.entries).toHaveLength(2)
    historySpy.mockClear()

    await render(true, { target: { kind: 'environment', environmentId: 'env-1' } })

    expect(historySpy.mock.calls.at(-1)?.[2].cursor).toBeUndefined()
    expect(latest?.entries.map((entry) => entry.run.id)).toEqual(['run-2'])
  })
})
