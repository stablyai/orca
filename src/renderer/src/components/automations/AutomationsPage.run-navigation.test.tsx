// @vitest-environment happy-dom

import { act, Profiler } from 'react'
import { createRoot } from 'react-dom/client'
import { within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import {
  api,
  installAutomationsPageHarness,
  mocks,
  renderPage,
  runtimeHost,
  addRuntimeProject,
  scopedList,
  settleHostQueries
} from './automations-page-test-harness'
import { makeAutomation, makeRun } from './automations-page-fixtures'
import { AutomationFailureBadge } from '../sidebar/AutomationFailureBadge'
import { useAutomationRunAcknowledgement } from './use-automation-run-acknowledgement'
import {
  AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
  AUTOMATION_RUN_SEEN_CAPABILITY
} from '../../../../shared/automation-runtime-capabilities'

vi.mock('@tanstack/react-virtual', async () => {
  const { createVirtualizerStub } = await import('./virtualizer-test-stub')
  return { useVirtualizer: createVirtualizerStub() }
})

installAutomationsPageHarness()

async function loadCachedHistory() {
  const automation = makeAutomation()
  const oldRun = makeRun({ id: 'run-26', runNumber: 26 })
  api.automations.list.mockResolvedValue([automation])
  scopedList([automation])
  api.automations.listRuns.mockResolvedValue([oldRun])
  mocks.state.selectedAutomationId = automation.id
  mocks.state.setPendingAutomationRunNavigation = mocks.setPendingRunNavigation
  mocks.setPendingRunNavigation.mockImplementation((navigation) => {
    mocks.state.pendingAutomationRunNavigation = navigation
  })
  const page = await renderPage()
  await settleHostQueries()
  return { ...page, automation, oldRun }
}

async function openDashboardRun(
  container: HTMLElement,
  newRun: AutomationRun,
  oldRun: AutomationRun
) {
  const fresh = Promise.withResolvers<AutomationRun[]>()
  api.automations.listRuns.mockImplementation((args?: { limit?: number }) =>
    args?.limit ? Promise.resolve([newRun, oldRun]) : fresh.promise
  )
  await act(async () => within(container).getByRole('button', { name: 'Runs' }).click())
  await act(async () => {
    within(container)
      .getByRole('button', { name: new RegExp(newRun.title) })
      .click()
  })
  return fresh
}

describe('AutomationsPage run navigation', () => {
  it('opens the automation overview without rereading its cached history', async () => {
    const { container, rerender, automation, oldRun } = await loadCachedHistory()
    const fresh = Promise.withResolvers<AutomationRun[]>()
    api.automations.listRuns.mockClear()
    api.automations.listRuns.mockReturnValue(fresh.promise)
    mocks.state.pendingAutomationRunNavigation = {
      automationId: automation.id,
      runId: null
    }

    await rerender()
    await settleHostQueries()

    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    expect(within(container).getByTestId('detail-pane')).toBeTruthy()
    expect(mocks.detailPane?.selectedRuns).toEqual([oldRun])
    expect(api.automations.listRuns).not.toHaveBeenCalled()
    expect(mocks.toastMessage).not.toHaveBeenCalled()
    await act(async () => fresh.resolve([oldRun]))
  })

  it('opens a new dashboard run after refreshing an already-cached automation history', async () => {
    const { container, oldRun } = await loadCachedHistory()
    await act(async () => within(container).getByRole('button', { name: 'Nightly' }).click())
    expect(within(container).getByTestId('detail-run-count').textContent).toBe('1')
    expect(mocks.detailPane?.selectedRuns.map((run) => run.id)).toEqual([oldRun.id])
    const breadcrumb = within(container).getByRole('navigation', {
      name: 'Automations breadcrumb'
    })
    await act(async () => within(breadcrumb).getByRole('button', { name: 'Automations' }).click())
    const newRun = makeRun({
      id: 'run-27',
      runNumber: 27,
      title: 'Nightly run 27',
      outputSnapshot: {
        format: 'plain_text',
        content: 'Fresh run output',
        capturedAt: 20,
        truncated: false
      }
    })
    const fresh = await openDashboardRun(container, newRun, oldRun)

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(mocks.state.pendingAutomationRunNavigation).toMatchObject({ runId: newRun.id })
    expect(within(container).getByRole('status').textContent).toContain('Loading runs')
    expect(within(container).queryByText('Fresh run output')).toBeNull()
    await act(async () => fresh.resolve([newRun, oldRun]))

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    expect(within(container).queryByRole('status')).toBeNull()
    expect(within(container).getByText('Fresh run output')).toBeTruthy()
    expect(within(container).getByRole('button', { name: 'Back to runs' })).toBeTruthy()
  })

  it('keeps the runs dashboard open when the user backs out of a pending read', async () => {
    const { container, oldRun } = await loadCachedHistory()
    const newRun = makeRun({ id: 'run-27', title: 'Nightly run 27' })
    const fresh = await openDashboardRun(container, newRun, oldRun)
    const breadcrumb = within(container).getByRole('navigation', {
      name: 'Automations breadcrumb'
    })

    await act(async () => within(breadcrumb).getByRole('button', { name: 'Runs' }).click())
    await act(async () => fresh.resolve([newRun, oldRun]))

    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    expect(within(container).getByRole('textbox', { name: 'Search runs…' })).toBeTruthy()
    expect(container.querySelector('[aria-label="Run context"]')).toBeNull()
    expect(mocks.toastMessage).not.toHaveBeenCalled()
  })

  it('shows loading for a workspace run link and cancels it with Escape', async () => {
    const { container, rerender, automation, oldRun } = await loadCachedHistory()
    const fresh = Promise.withResolvers<AutomationRun[]>()
    api.automations.listRuns.mockReturnValue(fresh.promise)
    mocks.state.pendingAutomationRunNavigation = {
      automationId: automation.id,
      runId: oldRun.id
    }

    await rerender()

    expect(within(container).getByRole('status').textContent).toContain('Loading runs')
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    await act(async () => fresh.resolve([oldRun]))

    expect(within(container).getByRole('textbox', { name: 'Search runs…' })).toBeTruthy()
    expect(container.querySelector('[aria-label="Run context"]')).toBeNull()
    expect(mocks.toastMessage).not.toHaveBeenCalled()
  })

  it('returns to automation details when cancelling a workspace run link from there', async () => {
    const { container, rerender, automation, oldRun } = await loadCachedHistory()
    await act(async () => within(container).getByRole('button', { name: 'Nightly' }).click())
    const fresh = Promise.withResolvers<AutomationRun[]>()
    api.automations.listRuns.mockReturnValue(fresh.promise)
    mocks.state.pendingAutomationRunNavigation = {
      automationId: automation.id,
      runId: oldRun.id
    }
    await rerender()

    expect(within(container).getByRole('status')).toBeTruthy()
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    })
    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    await act(async () => fresh.resolve([oldRun]))

    expect(within(container).getByTestId('detail-pane')).toBeTruthy()
    expect(container.querySelector('[aria-label="Run context"]')).toBeNull()
    expect(mocks.toastMessage).not.toHaveBeenCalled()
  })

  it('reports a missing run only after the fresh history confirms its absence', async () => {
    const { rerender, automation, oldRun } = await loadCachedHistory()
    const fresh = Promise.withResolvers<AutomationRun[]>()
    api.automations.listRuns.mockReturnValue(fresh.promise)
    mocks.state.pendingAutomationRunNavigation = {
      automationId: automation.id,
      runId: 'pruned-run'
    }

    await rerender()

    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(mocks.setPendingRunNavigation).not.toHaveBeenCalled()
    await act(async () => fresh.resolve([oldRun]))

    expect(mocks.toastMessage).toHaveBeenCalledWith('Run history no longer available.')
    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
  })

  it('shows the history error when opening a run from the dashboard fails', async () => {
    const { container, oldRun } = await loadCachedHistory()
    const newRun = makeRun({ id: 'run-27', title: 'Nightly run 27' })
    const fresh = await openDashboardRun(container, newRun, oldRun)

    await act(async () => fresh.reject(new Error('Host disconnected')))

    expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="detail-pane"]')).not.toBeNull()
    expect(mocks.detailPane?.selectedRunsNotice?.message).toContain('Host disconnected')
  })

  it.each(['all', 'desktop'] as const)(
    'resolves a workspace run link on its host with colliding ids under the %s filter',
    async (filter) => {
      const remoteRun = makeRun({
        id: 'run-26',
        outputSnapshot: {
          format: 'plain_text',
          content: 'Output from the selected remote host',
          capturedAt: 20,
          truncated: false
        }
      })
      runtimeHost([makeAutomation({ name: 'Remote nightly' })], [remoteRun])
      if (filter === 'desktop') {
        mocks.state.automationHostFilter = {
          kind: 'host',
          host: { authority: { kind: 'desktop' }, selector: { kind: 'self' } }
        }
      }
      mocks.setAutomationHostFilter.mockImplementation((next) => {
        mocks.state.automationHostFilter = next
      })
      const { container, rerender, automation } = await loadCachedHistory()
      const fresh = Promise.withResolvers<{ runs: AutomationRun[] }>()
      const originalRpc = mocks.callRuntimeRpc.getMockImplementation()
      mocks.callRuntimeRpc.mockImplementation(
        (target: unknown, method: unknown, ...args: unknown[]) => {
          if (
            method === 'automation.runs' &&
            typeof target === 'object' &&
            target !== null &&
            'kind' in target &&
            target.kind === 'environment' &&
            'environmentId' in target &&
            target.environmentId === 'gpu'
          ) {
            return fresh.promise
          }
          return originalRpc?.(target, method, ...args)
        }
      )
      await act(async () => {
        mocks.state.pendingAutomationRunNavigation = {
          automationId: automation.id,
          runId: remoteRun.id,
          hostId: 'runtime:gpu'
        }
      })
      await rerender()
      await rerender()

      expect(mocks.toastMessage).not.toHaveBeenCalled()
      expect(mocks.state.pendingAutomationRunNavigation).not.toBeNull()
      await act(async () => fresh.resolve({ runs: [remoteRun] }))

      expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
      expect(container.textContent).toContain('Output from the selected remote host')
      expect(mocks.toastMessage).not.toHaveBeenCalled()
    }
  )
})

it('acknowledges only a failed run actually opened in the visible Automations view', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  try {
    mocks.state.activeView = 'automations'
    const { rerender, automation } = await loadCachedHistory()
    visibility.mockReturnValue('hidden')
    const failed = makeRun({ id: 'failed', status: 'dispatch_failed', failureSeenAt: undefined })
    api.automations.listRuns.mockResolvedValue([failed])
    const originalRpc = mocks.callRuntimeRpc.getMockImplementation()
    mocks.callRuntimeRpc.mockImplementation(
      (target: unknown, method: unknown, ...args: unknown[]) => {
        if (method === 'automation.runSeen') {
          api.automations.listRuns.mockResolvedValue([{ ...failed, failureSeenAt: 100 }])
          return Promise.resolve({ seen: true })
        }
        return originalRpc?.(target, method, ...args)
      }
    )
    await rerender()
    expect(
      mocks.callRuntimeRpc.mock.calls.filter(([, method]) => method === 'automation.runSeen')
    ).toHaveLength(0)
    mocks.state.pendingAutomationRunNavigation = { automationId: automation.id, runId: failed.id }
    await rerender()
    await rerender()
    expect(
      mocks.callRuntimeRpc.mock.calls.filter(([, method]) => method === 'automation.runSeen')
    ).toHaveLength(0)
    visibility.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(
      mocks.callRuntimeRpc.mock.calls.filter(([, method]) => method === 'automation.runSeen')
    ).toEqual([
      [
        { kind: 'local' },
        'automation.runSeen',
        { id: automation.id, runId: failed.id, expectedOwner: { selector: { kind: 'self' } } },
        expect.anything()
      ]
    ])
  } finally {
    visibility.mockRestore()
  }
})

it('does not open a retained notification on a replacement pairing with colliding run ids', async () => {
  runtimeHost([makeAutomation({ name: 'Replacement host' })], [makeRun()])
  const { rerender, automation } = await loadCachedHistory()
  mocks.state.pendingAutomationRunNavigation = {
    automationId: automation.id,
    runId: 'run-26',
    hostId: 'runtime:gpu',
    pairingRevision: 3
  }
  await rerender()
  expect(mocks.state.pendingAutomationRunNavigation).toBeNull()
  expect(mocks.toastMessage).toHaveBeenCalledWith('Automation no longer available.')
  expect(
    mocks.callRuntimeRpc.mock.calls.filter(([, method]) => method === 'automation.runSeen')
  ).toHaveLength(0)
})

it('retries the production details acknowledgement on revisit after a running-to-failed transition', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const root = createRoot(document.createElement('div'))
  const owner = {
    owner: { authority: { kind: 'desktop' as const }, selector: { kind: 'self' as const } },
    selector: { kind: 'self' as const }
  }
  const running = makeRun({
    id: 'visible-live-run',
    status: 'dispatched',
    failureSeenAt: undefined
  })
  function Details({ run, visible }: { run: AutomationRun; visible: boolean }) {
    useAutomationRunAcknowledgement(run, owner, visible)
    return null
  }
  const render = async (run: AutomationRun, visible = true) => {
    await act(async () => root.render(<Details run={run} visible={visible} />))
  }
  try {
    mocks.state.activeView = 'automations'
    let attempts = 0
    mocks.callRuntimeRpc.mockImplementation((_target, method) => {
      if (method === 'automation.runSeen') {
        attempts++
        return attempts === 1
          ? Promise.reject(new Error('primary write failed'))
          : Promise.resolve({ seen: true })
      }
      return Promise.resolve({})
    })
    await render(running)
    expect(attempts).toBe(0)
    const failed = { ...running, status: 'dispatch_failed' as const }
    await render(failed)
    expect(attempts).toBe(1)
    expect(warn).toHaveBeenCalled()
    await render(failed, false)
    await render(failed)
    expect(attempts).toBe(2)
    await render({ ...failed })
    expect(attempts).toBe(2)
  } finally {
    await act(async () => root.unmount())
    visibility.mockRestore()
    warn.mockRestore()
  }
})

it.each([100, 1_000])(
  'bounds actual badge/page RPC and row work with %i rows, equal refresh, replay burst and teardown',
  async (size) => {
    let rowReads = 0
    let count = 0
    let badgeRenders = 0
    let remoteCount = 0
    const remote = makeAutomation({ id: 'remote-count' })
    runtimeHost([remote], [])
    addRuntimeProject()
    const capabilities = [
      AUTOMATION_LIST_HOST_SCOPE_RUNTIME_CAPABILITY,
      AUTOMATION_RUN_SEEN_CAPABILITY
    ]
    mocks.state.runtimeStatusByEnvironmentId = new Map([['gpu', { status: { capabilities } }]])
    mocks.getRuntimeEnvironmentStatus.mockResolvedValue({ capabilities })
    const original = mocks.callRuntimeRpc.getMockImplementation()!
    mocks.callRuntimeRpc.mockImplementation((target, method, ...args) => {
      if (target?.kind === 'environment' && method === 'automation.list') {
        return Promise.resolve({
          automations: [remote],
          items: [
            { automationId: remote.id, selector: { kind: 'self' }, unseenFailureCount: remoteCount }
          ],
          orphanCount: 0
        })
      }
      return original(target, method, ...args)
    })
    const automations = Array.from({ length: size }, (_, index) => {
      const automation = makeAutomation({ id: `measured-${index}`, name: `Measured ${index}` })
      const id = automation.id
      Object.defineProperty(automation, 'id', {
        get: () => {
          rowReads++
          return id
        },
        enumerable: true
      })
      return automation
    })
    api.automations.list.mockResolvedValue(automations)
    api.automations.listScoped.mockImplementation(async () => ({
      automations,
      items: automations.map((automation) => ({
        automationId: automation.id,
        selector: { kind: 'self' },
        unseenFailureCount: automation.id === 'measured-0' ? count : 0
      })),
      orphanCount: 0
    }))
    const { unmount } = await renderPage({
      peer: (
        <Profiler
          id="failure-badge"
          onRender={() => {
            badgeRenders++
          }}
        >
          <AutomationFailureBadge />
        </Profiler>
      )
    })
    await settleHostQueries()
    const calls = () =>
      mocks.callRuntimeRpc.mock.calls.filter(([, method]) => method === 'automation.list').length
    const initial = { calls: calls(), rows: rowReads, renders: badgeRenders }
    rowReads = 0
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('orca:automations-changed', {
          detail: { reason: 'usage', selector: { kind: 'self' } }
        })
      )
    )
    await settleHostQueries()
    const equal = {
      calls: calls() - initial.calls,
      rows: rowReads,
      renders: badgeRenders - initial.renders
    }
    expect(equal.renders).toBe(0)
    expect(equal.calls).toBeLessThanOrEqual(3)
    expect(equal.rows).toBeLessThanOrEqual(size * 40)
    const beforeBurst = calls()
    rowReads = 0
    await act(async () => {
      count = 1
      for (let index = 0; index < 10; index++) {
        window.dispatchEvent(
          new CustomEvent('orca:automations-changed', {
            detail: { reason: 'run', selector: { kind: 'self' } }
          })
        )
      }
    })
    await settleHostQueries()
    const burst = {
      calls: calls() - beforeBurst,
      rows: rowReads,
      renders: badgeRenders - initial.renders
    }
    expect(burst.calls).toBeLessThanOrEqual(12)
    expect(burst.rows).toBeLessThanOrEqual(size * 100)
    expect(document.querySelector('[aria-label="1 unseen failed runs"]')?.textContent).toBe('1')
    expect(badgeRenders).toBeGreaterThan(initial.renders)
    const localScoped = api.automations.listScoped.mock.calls.length
    const settledRenders = badgeRenders
    const crossCalls = calls()
    rowReads = 0
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('orca:automations-changed', {
          detail: { environmentId: 'gpu', reason: 'usage', selector: { kind: 'self' } }
        })
      )
    )
    await settleHostQueries()
    expect(badgeRenders).toBe(settledRenders)
    expect(api.automations.listScoped).toHaveBeenCalledTimes(localScoped)
    const remoteEqual = {
      calls: calls() - crossCalls,
      rows: rowReads,
      renders: badgeRenders - settledRenders
    }
    const changeCalls = calls()
    rowReads = 0
    await act(async () => {
      remoteCount = 1
      window.dispatchEvent(
        new CustomEvent('orca:automations-changed', {
          detail: { environmentId: 'gpu', reason: 'run', selector: { kind: 'self' } }
        })
      )
    })
    await settleHostQueries()
    expect(document.querySelector('[aria-label="2 unseen failed runs"]')?.textContent).toBe('2')
    expect(api.automations.listScoped).toHaveBeenCalledTimes(localScoped)
    const remoteUpdate = {
      calls: calls() - changeCalls,
      rows: rowReads,
      renders: badgeRenders - settledRenders
    }
    process.stdout.write(
      `${JSON.stringify({ size, initial, equal, burst, remoteEqual, remoteUpdate })}\n`
    )
    await unmount()
    const ended = calls()
    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('orca:automations-changed', { detail: { reason: 'run' } })
      )
    )
    await settleHostQueries()
    expect(calls()).toBe(ended)
  }
)
