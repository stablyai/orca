// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { getLocalAgentPreflightContext } from '@/lib/local-preflight-context'
import { localAgentInventoryContextKey } from '@/lib/local-preflight-context-key'
import { resetWindowsTerminalCapabilitiesForTests } from '@/lib/windows-terminal-capabilities'
import { useAgentPickerRefusedWake } from './use-agent-picker-refused-wake'

const initial = useAppStore.getInitialState()
const previousApi = Object.getOwnPropertyDescriptor(window, 'api')
const detect = vi.fn<Window['api']['preflight']['detectAgents']>()
const refused = new Error("WSL distro 'Ubuntu' is not running.")
const LOCAL = { kind: 'local', worktreeId: 'wt-1' } as const
const key = (id = LOCAL.worktreeId) =>
  localAgentInventoryContextKey(
    getLocalAgentPreflightContext(useAppStore.getState(), undefined, undefined, id)
  )
beforeEach(() => {
  resetWindowsTerminalCapabilitiesForTests()
  useAppStore.setState(initial, true)
  useAppStore.getState().clearLocalDetectedAgents()
  const repo = { ...TEST_REPO, path: 'C:\\project' }
  const catalog = projectHostSetupProjectionFromRepos([repo])
  useAppStore.setState({
    repos: [repo],
    projects: catalog.projects.map((project) => ({
      ...project,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })),
    projectHostSetups: [...catalog.setups],
    worktreesByRepo: {
      [repo.id]: ['wt-1', 'wt-2'].map((id) =>
        makeWorktree({ id, repoId: repo.id, path: repo.path })
      )
    },
    settings: getDefaultSettings('/tmp')
  })
  detect.mockReset().mockRejectedValue(refused)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      preflight: { detectAgents: detect },
      platform: { get: () => ({ platform: 'win32' }) }
    }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.getState().clearLocalDetectedAgents()
  useAppStore.setState(initial, true)
  resetWindowsTerminalCapabilitiesForTests()
  if (previousApi) {
    Object.defineProperty(window, 'api', previousApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it('wakes a refused WSL list once per open, even when the woken probe fails again (E9)', async () => {
  const pending = Promise.withResolvers<string[]>()
  detect.mockReturnValueOnce(pending.promise)
  const background = useAppStore.getState().ensureDetectedAgents('wt-1')
  const { rerender, unmount } = renderHook(
    ({ open, id }) => useAgentPickerRefusedWake(open, { kind: 'local', worktreeId: id }),
    {
      initialProps: { open: true, id: 'wt-1' }
    }
  )
  expect(useAppStore.getState().readLocalAgentInventoryByKey(key()).state).toBe('pending')
  expect(detect).toHaveBeenCalledTimes(1)
  await act(async () => {
    pending.reject(refused)
    await background
  })
  expect(detect).toHaveBeenCalledTimes(2)
  expect(detect).toHaveBeenLastCalledWith(
    expect.objectContaining({ enabledOnly: true, wakeWslDistro: true })
  )
  expect(useAppStore.getState().readLocalAgentInventoryByKey(key()).state).toBe('failed')
  expect(useAppStore.getState().isLocalAgentInventoryRefused('wt-1')).toBe(true)
  for (let iteration = 0; iteration < 2; iteration++) {
    await act(async () =>
      useAppStore.setState({ isDetectingLocalAgentsByContext: { [key()]: true } })
    )
    await act(async () => useAppStore.setState({ isDetectingLocalAgentsByContext: {} }))
  }
  expect(detect).toHaveBeenCalledTimes(2)
  rerender({ open: false, id: 'wt-1' })
  await act(async () => rerender({ open: true, id: 'wt-1' }))
  expect(detect).toHaveBeenCalledTimes(3)
  await act(async () => rerender({ open: true, id: 'wt-2' }))
  expect(detect).toHaveBeenCalledTimes(4)
  await act(async () => rerender({ open: true, id: 'wt-1' }))
  expect(detect).toHaveBeenCalledTimes(5)
  // A new context's successful inventory cannot inherit the previous context's refusal.
  await act(async () =>
    useAppStore.setState((state) => ({
      projects: state.projects.map((project) => ({
        ...project,
        localWindowsRuntimePreference: { kind: 'windows-host' }
      }))
    }))
  )
  expect(useAppStore.getState().isLocalAgentInventoryRefused('wt-1')).toBe(false)
  expect(detect).toHaveBeenCalledTimes(5)
  const late = Promise.withResolvers<string[]>()
  detect.mockReturnValueOnce(late.promise)
  const current = useAppStore.getState().ensureDetectedAgents('wt-1')
  unmount()
  await act(async () => {
    late.resolve([])
    await current
  })
  expect(useAppStore.getState().readLocalAgentInventory('wt-1')).toEqual({
    ids: [],
    state: 'successful'
  })
})

it('never retries a native or non-refusal failure while the picker is open', async () => {
  detect.mockRejectedValue(new Error('probe failed'))
  await useAppStore.getState().ensureDetectedAgents('wt-1')
  detect.mockClear()
  renderHook(() => useAgentPickerRefusedWake(true, LOCAL))
  await act(async () =>
    useAppStore.setState({ isDetectingLocalAgentsByContext: { [key()]: true } })
  )
  await act(async () => useAppStore.setState({ isDetectingLocalAgentsByContext: {} }))
  expect(detect).not.toHaveBeenCalled()
  await act(async () =>
    useAppStore.setState({
      localAgentInventoryFailedByContext: { [`${key()}\u0000all-agents`]: true }
    })
  )
  expect(detect).not.toHaveBeenCalled()
})

it('wakes nothing while closed or for a remote host', async () => {
  await useAppStore.getState().ensureDetectedAgents('wt-1')
  detect.mockClear()
  renderHook(() => useAgentPickerRefusedWake(false, LOCAL))
  renderHook(() => useAgentPickerRefusedWake(true, { kind: 'ssh', connectionId: 'ssh-1' }))
  expect(detect).not.toHaveBeenCalled()
})
