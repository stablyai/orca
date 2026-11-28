// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations/automation-definition'
import { useAppStore } from '@/store'
import { makeAutomation } from './automations-page-fixtures'
import { useAutomationsPageRefresh } from './use-automations-page-refresh'
import type { SelectedAutomationRunHistoryOutcome } from './runs/use-selected-automation-run-history'

vi.mock('@/app-shell/platform/paired-web-client-host', () => ({
  getPairedWebClientEnvironmentId: () => null
}))
afterEach(cleanup)
const reload = async () => {}
const emptyHistory: SelectedAutomationRunHistoryOutcome = {
  automationId: null,
  rowKey: null,
  ownerKey: null,
  authority: null,
  navigation: null,
  reloadToken: -1,
  runs: [],
  notice: null
}

function usePageReadState() {
  const [automations, setAutomations] = useState<Automation[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [automationHostTargetKey, setAutomationHostTargetKey] = useState<string | null>('local')
  const [failedAuthorityKeys, setFailedAuthorityKeys] = useState<ReadonlySet<string>>(new Set())
  const [selectedAutomationRuns, setSelectedAutomationRuns] = useState(emptyHistory)
  const [, setPageView] = useState<'automations' | 'runs' | 'run'>('automations')
  const [, setRelativeNow] = useState(0)
  const page = useAutomationsPageRefresh({
    store: {
      fetchAllWorktrees: useAppStore.getState().fetchAllWorktrees,
      startupWorktreeRefreshCompleted: false,
      pendingAutomationRunNavigation: null,
      runtimeEnvironments: [],
      selectedId: null
    },
    local: {
      setAutomations,
      isLoading,
      setIsLoading,
      automationHostTargetKey,
      setAutomationHostTargetKey,
      setFailedAuthorityKeys,
      setPageView,
      setRelativeNow,
      runHistoryReloadToken: 0,
      selectedRowKey: null,
      selectedAutomationRuns,
      setSelectedAutomationRuns,
      runHistoryAcquisitionToken: 0
    },
    list: { selectedRow: null, scopedExternal: { reload } },
    destination: {
      automationHostTargetFor: () => ({ kind: 'local' }),
      automationDispatchContext: { authority: { kind: 'desktop' }, capturedOwners: new Map() },
      getDefaultTarget: () => ({ projectId: '', workspaceId: '' })
    }
  })
  return { page, automations, failedAuthorityKeys }
}

it.each(['success', 'failure'] as const)(
  'does not publish an obsolete listing %s after a newer page refresh succeeds',
  async (outcome) => {
    const replies: { resolve: (value: unknown) => void; reject: (error: Error) => void }[] = []
    Object.defineProperty(window, 'api', {
      configurable: true,
      writable: true,
      value: {
        runtime: { call: () => new Promise((resolve, reject) => replies.push({ resolve, reject })) }
      }
    })
    const view = renderHook(usePageReadState)
    await waitFor(() => expect(replies).toHaveLength(1))
    let refreshed!: Promise<void>
    act(() => {
      refreshed = view.result.current.page.refresh()
    })
    await waitFor(() => expect(replies).toHaveLength(2))
    await act(async () => {
      replies[1].resolve({ ok: true, result: { automations: [makeAutomation({ name: 'Fresh' })] } })
      await refreshed
    })
    expect(view.result.current.automations[0]?.name).toBe('Fresh')
    await act(async () => {
      if (outcome === 'success') {
        replies[0].resolve({
          ok: true,
          result: { automations: [makeAutomation({ name: 'Obsolete' })] }
        })
      } else {
        replies[0].reject(new Error('Obsolete failure'))
      }
    })
    expect(view.result.current.automations[0]?.name).toBe('Fresh')
    expect([...view.result.current.failedAuthorityKeys]).toEqual([])
  }
)
