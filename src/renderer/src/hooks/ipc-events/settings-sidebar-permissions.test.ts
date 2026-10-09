import { afterEach, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { createTestStore } from '../../store/slices/store-test-helpers'
import { registerSettingsAndSidebarIpcBridge } from './settings-sidebar-ipc-bridge'

const mocks = vi.hoisted(() => ({ getState: vi.fn(), setState: vi.fn() }))
vi.mock('../../store', () => ({ useAppStore: mocks }))
vi.mock('../unpaired-device-auth-notification', () => ({
  subscribeToUnpairedDeviceAuthNotification: () => () => {}
}))
afterEach(() => vi.unstubAllGlobals())

it.each([
  [null, null, 'ask'],
  ['remote-host', 'remote-host', 'bypass'],
  [null, 'new-remote-host', undefined],
  ['remote-host', null, undefined],
  ['remote-host', 'another-remote-host', undefined]
] as const)(
  'keeps permission ownership through local broadcasts (%s to %s)',
  (environmentId, nextEnvironmentId, expected) => {
    const store = createTestStore()
    store.setState({
      settings: {
        ...getDefaultSettings(''),
        activeRuntimeEnvironmentId: environmentId,
        nativeChatPermissionMode: 'bypass'
      }
    })
    const fetchSettings = vi.fn(async () => {})
    store.setState({ fetchSettings })
    mocks.getState.mockImplementation(store.getState)
    mocks.setState.mockImplementation(store.setState)
    let listener: ((updates: Partial<GlobalSettings>) => void) | undefined
    const subscribe = () => () => {}
    vi.stubGlobal('window', {
      api: {
        ui: {
          onOpenSettings: subscribe,
          onOpenFeatureTour: subscribe,
          onStateChanged: subscribe,
          onToggleLeftSidebar: subscribe,
          onToggleRightSidebar: subscribe,
          onToggleWorktreePalette: subscribe,
          onToggleFloatingTerminal: subscribe
        },
        settings: {
          onChanged: (callback: typeof listener) => {
            listener = callback
            return () => {}
          }
        },
        mobile: {}
      }
    })
    const unsubs: (() => void)[] = []
    registerSettingsAndSidebarIpcBridge(unsubs)
    listener?.({
      nativeChatPermissionMode: 'ask',
      theme: 'dark',
      activeRuntimeEnvironmentId: nextEnvironmentId
    })
    expect(store.getState().settings?.nativeChatPermissionMode).toBe(expected)
    expect(fetchSettings).toHaveBeenCalledTimes(environmentId === nextEnvironmentId ? 0 : 1)
    expect(store.getState().settings?.theme).toBe('dark')
    unsubs.forEach((unsubscribe) => unsubscribe())
  }
)
