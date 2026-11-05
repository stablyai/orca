// @vitest-environment happy-dom
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

type StubStatusEntry = {
  status: { graphStatus: string; remoteControl?: { state: string } } | null
  remoteControl?: { state: string }
}
type StubStoreState = {
  runtimeEnvironments: { id: string; name: string; orcadDeployment?: { kind: string } }[]
  runtimeStatusByEnvironmentId: Map<string, StubStatusEntry>
}

const { storeState, callRuntimeRpc } = vi.hoisted(() => {
  const state: StubStoreState = { runtimeEnvironments: [], runtimeStatusByEnvironmentId: new Map() }
  return { storeState: state, callRuntimeRpc: vi.fn() }
})

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))
vi.mock('../../runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))

import { ClaudeStatsCacheSection, useClaudeStatsCache } from './ClaudeStatsCacheSection'
import { UsageTrackingPaneShell } from './UsageTrackingPaneShell'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  callRuntimeRpc.mockReset()
  storeState.runtimeEnvironments = []
  storeState.runtimeStatusByEnvironmentId = new Map()
})

const okHome = {
  configHome: '/home/dev/.claude',
  label: '~/.claude',
  status: 'ok' as const,
  totalTokens: 58_621_296_970,
  lastComputedDate: '2026-11-03'
}

function stubGetStatsCache(result: unknown): ReturnType<typeof vi.fn> {
  const getStatsCache = vi.fn(async () => result)
  vi.stubGlobal('api', { claudeUsage: { getStatsCache } })
  return getStatsCache
}

it('does not read /stats caches while tracking is off', () => {
  const getStatsCache = stubGetStatsCache([])
  const { result } = renderHook(() => useClaudeStatsCache(null))
  expect(getStatsCache).not.toHaveBeenCalled()
  expect(result.current).toEqual([])
})

it('treats the web fallback response as no homes', async () => {
  const getStatsCache = stubGetStatsCache(undefined)
  const { result } = renderHook(() => useClaudeStatsCache('0'))
  await waitFor(() => expect(getStatsCache).toHaveBeenCalledOnce())
  expect(result.current).toEqual([])
})

const connected: StubStatusEntry = { status: { graphStatus: 'ready' } }

it('labels connected servers and skips ones that cannot answer', async () => {
  stubGetStatsCache([okHome])
  storeState.runtimeEnvironments = [
    { id: 'env-ssh', name: 'build-box' },
    { id: 'env-old', name: 'old-server' },
    { id: 'env-down', name: 'offline' },
    { id: 'env-disconnected', name: 'disconnected' },
    { id: 'env-wsl', name: 'WSL Ubuntu', orcadDeployment: { kind: 'wsl' } },
    { id: 'env-no-runtime', name: 'no-runtime' }
  ]
  storeState.runtimeStatusByEnvironmentId = new Map([
    ['env-ssh', connected],
    ['env-old', connected],
    ['env-down', { status: null }],
    ['env-disconnected', { status: { graphStatus: 'ready', remoteControl: { state: 'closed' } } }],
    ['env-wsl', connected],
    ['env-no-runtime', { status: null, remoteControl: { state: 'ready' } }]
  ])
  callRuntimeRpc.mockImplementation(async (target: { environmentId: string }) => {
    if (target.environmentId === 'env-old') {
      throw new Error('method_not_found')
    }
    return [{ ...okHome, totalTokens: 7 }]
  })
  const { result } = renderHook(() => useClaudeStatsCache('0'))
  await waitFor(() => expect(result.current).toHaveLength(2))
  expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
  expect(callRuntimeRpc.mock.calls.map((call) => call[1])).toEqual([
    'stats.claudeStatsCache',
    'stats.claudeStatsCache'
  ])
  expect(result.current).toMatchObject([
    { hostName: null, totalTokens: 58_621_296_970 },
    { hostName: 'build-box', totalTokens: 7 }
  ])
})

it('shows the local row before a slow server answers and aborts on unmount', async () => {
  stubGetStatsCache([okHome])
  storeState.runtimeEnvironments = [{ id: 'env-ssh', name: 'build-box' }]
  storeState.runtimeStatusByEnvironmentId = new Map([['env-ssh', connected]])
  let resolveRemote: (value: unknown) => void = () => {}
  callRuntimeRpc.mockReturnValue(new Promise((resolve) => (resolveRemote = resolve)))
  const { result, unmount } = renderHook(() => useClaudeStatsCache('0'))
  await waitFor(() => expect(result.current).toMatchObject([{ hostName: null }]))
  await act(async () => resolveRemote([{ ...okHome, totalTokens: 7 }]))
  expect(result.current).toMatchObject([{ hostName: null }, { hostName: 'build-box' }])
  unmount()
  expect(callRuntimeRpc.mock.calls[0][3].signal.aborted).toBe(true)
})

it('drops malformed server rows without crashing the summary', async () => {
  stubGetStatsCache([])
  storeState.runtimeEnvironments = [{ id: 'env-ssh', name: 'build-box' }]
  storeState.runtimeStatusByEnvironmentId = new Map([['env-ssh', connected]])
  callRuntimeRpc.mockResolvedValue([
    { configHome: '/a', label: 'no-total', status: 'ok', lastComputedDate: '2026-11-03' },
    { configHome: '/b', label: 'bad-date', status: 'ok', totalTokens: 1, lastComputedDate: 3 },
    { configHome: '/c', label: 'future', status: 'unavailable', reason: 'new-reason' }
  ])
  function Section(): React.JSX.Element | null {
    return <ClaudeStatsCacheSection homes={useClaudeStatsCache('0')} />
  }
  render(<Section />)
  await waitFor(() =>
    expect(screen.getByText('build-box · future · Could not read /stats file')).toBeTruthy()
  )
  expect(screen.queryByText(/no-total|bad-date/)).toBeNull()
})

it('keeps lifetime totals visible when the filters match no Orca data', () => {
  render(
    <UsageTrackingPaneShell
      title="Claude"
      enableLabel="enable"
      onEnabledChange={() => {}}
      enabled
      status="status"
      isRefreshing={false}
      hasData={false}
      optionsLabel="options"
      filtersLabel="filters"
      refreshAriaLabel="refresh"
      refreshLabel="refresh"
      filterSections={[]}
      selectionSummary="summary"
      emptyMessage="No local Claude usage"
      onRefresh={() => {}}
      titleAccessory={
        <ClaudeStatsCacheSection homes={[{ ...okHome, hostName: null, key: 'local' }]} />
      }
    >
      <p>filtered</p>
    </UsageTrackingPaneShell>
  )
  expect(screen.getByText(/lifetime tokens/)).toBeTruthy()
})
