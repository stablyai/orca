// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  JIRA_SAVED_FILTER_RUNTIME_CAPABILITY,
  JIRA_SAVED_FILTER_UPDATE_REQUIRED
} from '../../../../shared/jira/jira-saved-filter-capability'
import {
  JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
  JIRA_STATUS_FILTER_UPDATE_REQUIRED
} from '../../../../shared/jira-quick-filters'
import {
  mutateJiraSavedFilters,
  readJiraSavedFilterState
} from '../../runtime/runtime-jira-saved-filter-state'
import {
  readJiraQuickFilterState,
  writeJiraQuickFilterState
} from '../../runtime/runtime-jira-quick-filter-state'
import { createWebUiApi } from './web-ui-api'

const runtime = vi.hoisted(() => {
  const state: { activeId: string; idAfterProbe: string | null } = {
    activeId: 'host-a',
    idAfterProbe: null
  }
  return Object.assign(state, { call: vi.fn(), status: vi.fn() })
})
vi.mock('./web-runtime-calls', () => ({
  callRuntimeResult: runtime.call,
  getRemoteRuntimeStatus: async () => {
    const status = await runtime.status()
    if (runtime.idAfterProbe) {
      runtime.activeId = runtime.idAfterProbe
    }
    return status
  }
}))
vi.mock('./web-runtime-session', () => ({
  webRuntimeState: { activeEnvironment: null },
  requireActiveEnvironmentOrNull: () => ({ id: runtime.activeId }),
  requireActiveEnvironment: () => ({ id: runtime.activeId }),
  assertActiveEnvironment: (id: string) => {
    if (id !== runtime.activeId) {
      throw new Error('Pairing changed')
    }
  }
}))
const rpc = vi.hoisted(() => vi.fn())
vi.mock('../../runtime/runtime-rpc-client', () => ({
  assertRuntimeEnvironmentCapability: vi.fn(),
  callRuntimeRpc: rpc
}))

const savedState = {
  filters: [{ id: 'mine', name: 'My work', jql: 'project = APP' }],
  activeFilterId: 'mine'
}
const quickState = { statuses: ['In Progress'] }
const BOTH = [JIRA_SAVED_FILTER_RUNTIME_CAPABILITY, JIRA_STATUS_FILTER_RUNTIME_CAPABILITY]

beforeEach(() => {
  localStorage.clear()
  runtime.call.mockReset()
  runtime.status.mockReset()
  runtime.activeId = 'host-a'
  runtime.idAfterProbe = null
  rpc.mockReset()
  vi.stubGlobal('window', { localStorage, api: { ui: createWebUiApi() } })
})
afterEach(() => vi.unstubAllGlobals())

it('reads and writes Jira filter state on the paired host from the local target', async () => {
  runtime.status.mockResolvedValue({ capabilities: BOTH })
  runtime.call.mockImplementation(async (method: string) =>
    method.includes('Saved') ? savedState : quickState
  )

  expect(await readJiraSavedFilterState({ kind: 'local' })).toEqual(savedState)
  await mutateJiraSavedFilters({ kind: 'local' }, { kind: 'select', id: 'mine' })
  await readJiraQuickFilterState({ kind: 'local' })
  await writeJiraQuickFilterState({ kind: 'local' }, quickState)

  expect(runtime.call.mock.calls).toEqual([
    ['ui.getJiraSavedFilters', undefined, 15_000],
    ['ui.mutateJiraSavedFilters', { kind: 'select', id: 'mine' }, 15_000],
    ['ui.getJiraQuickFilters', undefined, 15_000],
    ['ui.setJiraQuickFilters', quickState, 15_000]
  ])
  expect(rpc).not.toHaveBeenCalled()
})

it('reports update-required for an older host and never sends the new methods', async () => {
  runtime.status.mockResolvedValue({ capabilities: [] })

  await expect(readJiraSavedFilterState({ kind: 'local' })).rejects.toThrow(
    JIRA_SAVED_FILTER_UPDATE_REQUIRED
  )
  await expect(
    mutateJiraSavedFilters({ kind: 'local' }, { kind: 'select', id: null })
  ).rejects.toThrow(JIRA_SAVED_FILTER_UPDATE_REQUIRED)
  await expect(readJiraQuickFilterState({ kind: 'local' })).rejects.toThrow(
    JIRA_STATUS_FILTER_UPDATE_REQUIRED
  )
  await expect(writeJiraQuickFilterState({ kind: 'local' }, quickState)).rejects.toThrow(
    JIRA_STATUS_FILTER_UPDATE_REQUIRED
  )
  expect(runtime.call).not.toHaveBeenCalled()
})

it('rejects host failures instead of returning empty or unsaved state', async () => {
  runtime.status.mockRejectedValueOnce(new Error('Connection lost'))
  await expect(readJiraSavedFilterState({ kind: 'local' })).rejects.toThrow('Connection lost')

  runtime.status.mockResolvedValue({ capabilities: BOTH })
  runtime.call.mockRejectedValue(new Error('Host write failed'))
  await expect(writeJiraQuickFilterState({ kind: 'local' }, quickState)).rejects.toThrow(
    'Host write failed'
  )
})

it('does not send to a host paired in while the capability probe was in flight', async () => {
  runtime.status.mockResolvedValue({ capabilities: BOTH })
  runtime.idAfterProbe = 'host-b'

  await expect(
    mutateJiraSavedFilters({ kind: 'local' }, { kind: 'select', id: 'mine' })
  ).rejects.toThrow('Pairing changed')
  expect(runtime.call).not.toHaveBeenCalled()
})

it('keeps explicit environment targets on the environment RPC path', async () => {
  rpc.mockResolvedValue(savedState)

  await readJiraSavedFilterState({ kind: 'environment', environmentId: 'host-c' })

  expect(rpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'host-c' },
    'ui.getJiraSavedFilters',
    undefined,
    { timeoutMs: 15_000 }
  )
  expect(runtime.call).not.toHaveBeenCalled()
})
