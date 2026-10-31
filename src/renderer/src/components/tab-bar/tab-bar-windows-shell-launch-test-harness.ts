import { vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AppState } from '@/store/types'
import { createTestStore } from '@/store/slices/store-test-helpers'

const store = createTestStore()
const initial = store.getState()
export const pinTabMock: (tabId: string) => void = vi.fn()
export const unpinTabMock: (tabId: string) => void = vi.fn()

export const appStoreSnapshot = {
  get activeRepoId() {
    return store.getState().activeRepoId
  },
  set activeRepoId(value: AppState['activeRepoId']) {
    store.setState({ activeRepoId: value })
  },
  get activeWorktreeId() {
    return store.getState().activeWorktreeId
  },
  set activeWorktreeId(value: AppState['activeWorktreeId']) {
    store.setState({ activeWorktreeId: value })
  },
  get projects() {
    return store.getState().projects
  },
  set projects(value: AppState['projects']) {
    store.setState({ projects: value })
  },
  get repos() {
    return store.getState().repos
  },
  set repos(value: AppState['repos']) {
    store.setState({ repos: value })
  },
  get sshConnectionStates() {
    return store.getState().sshConnectionStates
  },
  set sshConnectionStates(value: AppState['sshConnectionStates']) {
    store.setState({ sshConnectionStates: value })
  },
  get worktreesByRepo() {
    return store.getState().worktreesByRepo
  },
  set worktreesByRepo(value: AppState['worktreesByRepo']) {
    store.setState({ worktreesByRepo: value })
  },
  get activeRuntimeEnvironmentId() {
    return store.getState().settings?.activeRuntimeEnvironmentId ?? null
  },
  set activeRuntimeEnvironmentId(value: string | null) {
    store.setState({
      settings: {
        ...getDefaultSettings('/tmp'),
        ...store.getState().settings,
        activeRuntimeEnvironmentId: value
      }
    })
  }
}

export const useAppStoreExport = Object.assign(
  <T>(selector: (state: AppState) => T): T => selector(store.getState()),
  { getState: store.getState }
)

export function resetAppStoreSnapshot(): void {
  store.setState(
    {
      ...initial,
      pinTab: pinTabMock,
      unpinTab: unpinTabMock,
      settings: {
        ...getDefaultSettings('/tmp'),
        terminalWindowsShell: 'powershell.exe',
        terminalWindowsPowerShellImplementation: 'pwsh.exe',
        activeRuntimeEnvironmentId: null,
        localWindowsRuntimeDefault: { kind: 'windows-host' }
      }
    },
    true
  )
}
