// @vitest-environment happy-dom

/** Refresh reaches one authority at a time; deriving selection/history from that answer would drop or mislabel other hosts’ rows under All hosts. */

import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  refreshOnFocus,
  renderPage,
  RUNTIME_SELF_FILTER,
  runtimeHost,
  scopedList,
  SELF_PRECONDITION,
  settleHostQueries
} from './automations-page-test-harness'
import { listedRows } from './automations-page-listed-items'
import { makeAutomation, makeRun, WORKSPACE_ID } from './automations-page-fixtures'
import {
  AUTOMATIONS_CHANGED_EVENT,
  emitAutomationsChangedWindowEvent
} from '@/lib/automations-changed-window-event'

async function openAutomationRow(container: HTMLElement, name: string): Promise<void> {
  const row = [
    ...container.querySelectorAll<HTMLButtonElement>('[data-testid="automation-row"]')
  ].find((candidate) => candidate.textContent === name)
  expect(row).toBeTruthy()
  await act(async () => row?.click())
  await settleHostQueries()
}

describe('AutomationsPage refresh', () => {
  installAutomationsPageHarness()

  it('never asks a host for every run it has retained', async () => {
    const run = makeRun({ id: 'run-1', automationId: 'a-1' })
    api.automations.list.mockResolvedValue([makeAutomation({ id: 'a-1' })])
    api.automations.listRuns.mockResolvedValue([run])

    await renderPage()

    // Request one automation’s history; whole-host history would scale page cost with retention.
    for (const [args] of api.automations.listRuns.mock.calls) {
      expect(args?.automationId).toBeTruthy()
    }
  })

  it.each(['desktop', 'runtime'] as const)(
    'refreshes count and exact saved output on successive %s completion events without re-entry',
    async (authority) => {
      const automation = makeAutomation({ name: 'Selected nightly' })
      scopedList(authority === 'desktop' ? [automation] : [])
      api.automations.list.mockResolvedValue(authority === 'desktop' ? [automation] : [])
      if (authority === 'runtime') {
        runtimeHost([automation], [])
        mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
      }
      const { container } = await renderPage()
      await openAutomationRow(container, automation.name)
      const count = container.querySelector('[data-testid="detail-run-count"]')
      expect(count?.textContent).toBe('0')
      const reads = (): unknown[][] =>
        mocks.callRuntimeRpc.mock.calls.filter(([, method]) => method === 'automation.runs')
      const beforeEvents = reads().length
      for (const unrelated of [
        {
          environmentId: authority === 'desktop' ? 'gpu' : null,
          selector: { kind: 'self' as const }
        },
        {
          environmentId: authority === 'runtime' ? 'gpu' : null,
          selector: { kind: 'ssh' as const, targetId: 'elsewhere' }
        }
      ]) {
        await act(async () => emitAutomationsChangedWindowEvent({ ...unrelated, reason: 'run' }))
        await settleHostQueries()
        expect(reads()).toHaveLength(beforeEvents)
        expect(container.querySelector('[data-testid="detail-run-count"]')).toBe(count)
      }
      const event = {
        ...(authority === 'runtime' ? { environmentId: 'gpu' } : {}),
        selector: { kind: 'self' as const },
        reason: 'run' as const
      }
      const first = makeRun({
        id: 'first-completed',
        outputSnapshot: {
          format: 'plain_text',
          content: 'First exact reply',
          capturedAt: 1,
          truncated: false
        }
      })
      const answer = (runs: (typeof first)[]): void => {
        api.automations.listRuns.mockResolvedValue(runs)
        if (authority === 'runtime') {
          mocks.state.runtimeAnswers = { automations: [automation], runs }
        }
      }
      answer([first])
      await act(async () => emitAutomationsChangedWindowEvent(event))
      await settleHostQueries()
      expect(count?.textContent).toBe('1')
      expect(mocks.detailPane?.selectedRuns).toEqual([first])
      expect(reads()).toHaveLength(beforeEvents + 1)
      await act(async () => mocks.detailPane?.openAutomationRunPage(first))
      expect(container.textContent).toContain('First exact reply')
      const revised = {
        ...first,
        outputSnapshot: { ...first.outputSnapshot!, content: 'Settled first exact reply' }
      }
      const second = makeRun({ id: 'second-completed' })
      answer([second, revised])
      await act(async () => emitAutomationsChangedWindowEvent(event))
      await settleHostQueries()
      expect(container.textContent).toContain('Settled first exact reply')
      expect(reads()).toHaveLength(beforeEvents + 2)
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Back to runs"]')?.click()
      )
      expect(container.querySelector('[data-testid="detail-run-count"]')?.textContent).toBe('2')
      expect(mocks.detailPane?.selectedRuns.map((run) => run.id)).toEqual([
        'second-completed',
        'first-completed'
      ])
      for (const [target, , params, options] of reads().slice(beforeEvents)) {
        expect(target).toEqual(
          authority === 'runtime'
            ? { kind: 'environment', environmentId: 'gpu' }
            : { kind: 'local' }
        )
        expect(params).toEqual({ automationId: automation.id, expectedOwner: SELF_PRECONDITION })
        if (authority === 'runtime') {
          expect(options).toMatchObject({ expectedEnvironmentPairingRevision: 4 })
        }
      }
      await settleHostQueries()
      expect(reads()).toHaveLength(beforeEvents + 2)
    }
  )

  it('reads row usage from the authority projection rather than from runs', async () => {
    const usageSummary = {
      knownRuns: 2,
      unavailableRuns: 0,
      inputTokens: 900,
      outputTokens: 300,
      cacheTokens: 0,
      reasoningOutputTokens: 34,
      totalTokens: 1234,
      estimatedCostUsd: 0.5
    }
    api.automations.listScoped.mockResolvedValue({
      automations: [makeAutomation({ id: 'a-1' })],
      items: [{ automationId: 'a-1', selector: { kind: 'self' }, usageSummary }],
      orphanCount: 0
    })

    await renderPage()

    expect(listedRows()[0]?.usageSummary).toEqual(usageSummary)
  })

  it('does not re-list through the active runtime just because one is selected', async () => {
    mocks.state.settings = {
      ...(mocks.state.settings as Record<string, unknown>),
      activeRuntimeEnvironmentId: 'gpu'
    }

    await renderPage()

    // The ambient runtime cannot identify a row owner; unscoped desktop and scoped runtime queries stay separate.
    expect(api.automations.list).toHaveBeenCalled()
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'gpu' },
      'automation.list',
      undefined,
      { timeoutMs: 15_000 }
    )
  })

  // The manual All-hosts refresh: without a control wired to it, a host whose
  // entry stopped short has nothing that re-queries it.
  it('re-queries the desktop host in view from the header refresh action', async () => {
    const { container } = await renderPage()
    api.automations.listScoped.mockClear()

    const refresh = container.querySelector<HTMLElement>('[aria-label="Refresh automations"]')
    expect(refresh).not.toBeNull()
    await act(async () => refresh?.click())

    // Inside the 30s TTL, so only a manual refresh can produce this call.
    expect(api.automations.listScoped).toHaveBeenCalledWith({ selector: { kind: 'self' } })
  })

  it('does not re-run the whole refresh when the settings identity changes', async () => {
    const { rerender } = await renderPage()
    expect(api.automations.list).toHaveBeenCalledTimes(1)

    mocks.state.settings = { ...(mocks.state.settings as Record<string, unknown>) }
    await rerender()

    // Settings no longer aim the list, so a new settings object is not a reason
    // to re-fetch every host.
    expect(api.automations.list).toHaveBeenCalledTimes(1)
  })
})

describe('AutomationsPage selection', () => {
  installAutomationsPageHarness()

  it('keeps an acquired exact run through definition removal, failed history settlement and Back', async () => {
    const automation = makeAutomation({ id: 'a-1', name: 'Nightly' })
    const leafId = '11111111-1111-4111-8111-111111111111'
    const run = makeRun({
      id: 'old-run',
      automationId: automation.id,
      workspaceId: WORKSPACE_ID,
      workspaceDisplayName: 'Original workspace',
      terminalSessionId: 'recorded-tab',
      terminalPaneKey: `recorded-tab:${leafId}`,
      terminalPtyId: 'recorded-pty',
      outputSnapshot: {
        format: 'plain_text',
        content: 'Saved exact historical output',
        capturedAt: 1,
        truncated: false
      }
    })
    scopedList([automation])
    api.automations.list.mockResolvedValue([automation])
    api.automations.listRuns.mockResolvedValue([run])
    mocks.state.selectedAutomationId = automation.id
    mocks.state.setSelectedAutomationId = (id: string | null) => {
      mocks.state.selectedAutomationId = id
    }
    mocks.state.tabsByWorktree = {}
    mocks.state.folderWorkspaces = []
    mocks.state.projectGroups = []
    mocks.state.unifiedTabsByWorktree = {
      [WORKSPACE_ID]: [
        {
          id: 'recorded-tab',
          entityId: 'recorded-tab',
          worktreeId: WORKSPACE_ID,
          contentType: 'terminal',
          executionHostId: 'local'
        }
      ]
    }
    mocks.state.terminalLayoutsByTabId = {
      'recorded-tab': {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        ptyIdsByLeafId: { [leafId]: 'recorded-pty' }
      }
    }
    mocks.state.ptyIdsByTabId = { 'recorded-tab': ['recorded-pty'] }
    const { container, rerender } = await renderPage()
    await openAutomationRow(container, 'Nightly')
    const retryHistory = mocks.detailPane?.recoverSelectedRuns
    await act(async () => mocks.detailPane?.openAutomationRunPage(run))
    expect(container.textContent).toContain('Saved exact historical output')
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'View run')
    ).toBe(true)
    scopedList([])
    api.automations.list.mockResolvedValue([])
    api.automations.listRuns.mockRejectedValue(new Error('History temporarily unavailable'))
    const readsBeforeFailure = api.automations.listRuns.mock.calls.length
    await act(async () =>
      emitAutomationsChangedWindowEvent({ selector: { kind: 'self' }, reason: 'run' })
    )
    await settleHostQueries()
    expect(api.automations.listRuns.mock.calls.length).toBe(readsBeforeFailure + 1)
    expect(container.textContent).toContain('Saved exact historical output')
    await rerender()
    const readsBeforeRetry = api.automations.listRuns.mock.calls.length
    await act(async () => retryHistory?.('retry'))
    await settleHostQueries()
    expect(api.automations.listRuns.mock.calls.length).toBeGreaterThan(readsBeforeRetry)
    expect(container.textContent).toContain('Saved exact historical output')
    expect(container.querySelector('[aria-label="Back to runs"]')).not.toBeNull()
    expect(
      [...container.querySelectorAll('button')].some((button) => button.textContent === 'View run')
    ).toBe(true)
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Back to runs"]')?.click()
    )
    expect(container.querySelector('[data-testid="list-panel"]')).not.toBeNull()
    expect(mocks.toastMessage).not.toHaveBeenCalledWith('Run history no longer available.')
  })

  it('reacquires a same-row SSH incarnation only after explicit selection, retaining old output through Retry and Back', async () => {
    const automation = makeAutomation({ id: 'ssh-a', name: 'Captured SSH' })
    mocks.state.selectedAutomationId = automation.id
    mocks.state.setSelectedAutomationId = (id: string | null) => {
      mocks.state.selectedAutomationId = id
    }
    const run = makeRun({
      id: 'older-ssh-run',
      automationId: automation.id,
      outputSnapshot: {
        format: 'plain_text',
        content: 'Captured old output',
        capturedAt: 1,
        truncated: false
      }
    })
    mocks.state.folderWorkspaces = []
    mocks.state.projectGroups = []
    let generation = 7
    mocks.state.sshTargetLabels = new Map([['box', 'Box']])
    mocks.state.sshTargetGenerations = new Map([['box', generation]])
    mocks.state.sshConnectionStates = new Map([['box', { status: 'connected' }]])
    api.automations.listScoped.mockImplementation(async (args) => ({
      automations: args?.selector?.kind === 'ssh' ? [automation] : [],
      items:
        args?.selector?.kind === 'ssh'
          ? [
              {
                automationId: automation.id,
                selector: { kind: 'ssh', targetId: 'box', targetGeneration: generation }
              }
            ]
          : [],
      orphanCount: 0
    }))
    api.automations.listRuns.mockResolvedValue([run])
    const { container, rerender } = await renderPage()
    await openAutomationRow(container, 'Captured SSH')
    await act(async () => mocks.detailPane?.openAutomationRunPage(run))
    expect(container.textContent).toContain('Captured old output')
    generation = 9
    mocks.state.sshTargetGenerations = new Map([['box', generation]])
    await rerender()
    await act(async () => window.dispatchEvent(new Event(AUTOMATIONS_CHANGED_EVENT)))
    await settleHostQueries()
    expect(container.textContent).toContain('Captured old output')
    const back = container.querySelector<HTMLButtonElement>('[aria-label="Back to runs"]')
    expect(back).not.toBeNull()
    await act(async () => back?.click())
    expect(container.querySelector('[data-testid="detail-pane"]')).not.toBeNull()
    const beforeRetry = api.automations.listRuns.mock.calls.length
    await act(async () => mocks.detailPane?.recoverSelectedRuns('retry'))
    await settleHostQueries()
    expect(api.automations.listRuns.mock.calls.length).toBeGreaterThan(beforeRetry)
    expect(
      api.automations.listRuns.mock.calls
        .slice(beforeRetry)
        .every(([args]) => args?.expectedOwner?.selector?.targetGeneration !== 9)
    ).toBe(true)
    expect(mocks.detailPane?.selectedRuns).toEqual([run])
    const automations = [...container.querySelectorAll<HTMLButtonElement>('nav button')].find(
      (button) => button.textContent === 'Automations'
    )
    expect(automations).toBeTruthy()
    await act(async () => automations?.click())
    const beforeReselect = api.automations.listRuns.mock.calls.length
    await openAutomationRow(container, 'Captured SSH')
    expect(
      api.automations.listRuns.mock.calls
        .slice(beforeReselect)
        .some(([args]) => args?.expectedOwner?.selector?.targetGeneration === 9)
    ).toBe(true)
  })

  it('loads the first automation into the detail pane and fetches its runs', async () => {
    const run = makeRun({ id: 'run-1', automationId: 'a-1' })
    api.automations.list.mockResolvedValue([makeAutomation({ id: 'a-1', name: 'Nightly' })])
    api.automations.listRuns.mockImplementation(async (args?: { automationId?: string }) =>
      args?.automationId === 'a-1' ? [run] : []
    )

    const { container } = await renderPage()
    await openAutomationRow(container, 'Nightly')

    // Read history once through its row’s fence; page-level desktop refresh must not duplicate it unfenced.
    expect(api.automations.listRuns).toHaveBeenCalledWith({
      automationId: 'a-1',
      expectedOwner: SELF_PRECONDITION
    })
    expect(container.querySelector('[data-testid="detail-name"]')?.textContent).toBe('Nightly')
    expect(mocks.detailPane?.selectedRuns).toEqual([run])
  })

  it('fetches the newly selected automation runs when the selection changes', async () => {
    scopedList([
      makeAutomation({ id: 'a-1', name: 'Nightly' }),
      makeAutomation({ id: 'a-2', name: 'Weekly' })
    ])

    const { container, rerender } = await renderPage()
    api.automations.listRuns.mockClear()

    mocks.state.selectedAutomationId = 'a-2'
    await rerender()
    await openAutomationRow(container, 'Weekly')

    // Fence history reads too so moved rows refuse rather than answer from a former host.
    expect(api.automations.listRuns).toHaveBeenCalledWith({
      automationId: 'a-2',
      expectedOwner: SELF_PRECONDITION
    })
    expect(mocks.detailPane?.selected?.id).toBe('a-2')
  })
})

describe('AutomationsPage multi-host selection', () => {
  installAutomationsPageHarness()

  it('keeps a selection that lives on another host when the window regains focus', async () => {
    runtimeHost([makeAutomation({ id: 'a-remote', name: 'Remote nightly' })], [])
    const desktop = makeAutomation({ id: 'a-desktop', name: 'Desktop nightly' })
    scopedList([desktop])
    api.automations.list.mockResolvedValue([desktop])
    const setSelectedAutomationId = vi.fn((id: string | null) => {
      mocks.state.selectedAutomationId = id
    })
    mocks.state.selectedAutomationId = 'a-remote'
    mocks.state.setSelectedAutomationId = setSelectedAutomationId

    const { container, rerender } = await renderPage()
    await settleHostQueries()
    await refreshOnFocus()
    await rerender()

    // One authority’s refresh cannot decide whether another authority’s selected row still exists.
    expect(setSelectedAutomationId).not.toHaveBeenCalled()
    await openAutomationRow(container, 'Remote nightly')
    expect(container.querySelector('[data-testid="detail-name"]')?.textContent).toBe(
      'Remote nightly'
    )
  })

  it('shows the selected host’s runs when another authority holds the same id', async () => {
    runtimeHost(
      [makeAutomation({ id: 'a-1', name: 'Remote nightly' })],
      [makeRun({ id: 'run-remote', automationId: 'a-1' })]
    )
    // IDs can collide across authorities; desktop remains independently reachable.
    api.automations.list.mockResolvedValue([makeAutomation({ id: 'a-1', name: 'Desktop nightly' })])
    api.automations.listRuns.mockResolvedValue([
      makeRun({ id: 'run-desktop', automationId: 'a-1' })
    ])
    scopedList([])
    mocks.state.automationHostFilter = RUNTIME_SELF_FILTER
    mocks.state.selectedAutomationId = 'a-1'

    const { container } = await renderPage()
    await settleHostQueries()
    await refreshOnFocus()
    await openAutomationRow(container, 'Remote nightly')

    expect(mocks.detailPane?.selected?.name).toBe('Remote nightly')
    expect(mocks.detailPane?.selectedRuns.map((run) => run.id)).toEqual(['run-remote'])
  })

  it('keeps both authorities’ rows on screen and selectable under All hosts', async () => {
    runtimeHost(
      [makeAutomation({ id: 'a-1', name: 'Remote nightly' })],
      [makeRun({ id: 'run-remote', automationId: 'a-1' })]
    )
    scopedList([makeAutomation({ id: 'a-1', name: 'Desktop nightly' })])
    // The stored id names the record; only the row key can say whose copy.
    mocks.state.selectedAutomationId = 'a-1'

    const { container } = await renderPage()
    await settleHostQueries()

    // Two stored records, not one row and a silent drop into #44's empty state.
    expect(
      [...container.querySelectorAll('[data-testid="automation-row"]')].map(
        (row) => row.textContent
      )
    ).toEqual(['Desktop nightly', 'Remote nightly'])

    const remote = listedRows().find((row) => row.automation.name === 'Remote nightly')
    await act(async () => {
      mocks.listPanel?.selectAutomationRow(remote?.key ?? '')
    })

    expect(mocks.detailPane?.selected?.name).toBe('Remote nightly')
  })
})
