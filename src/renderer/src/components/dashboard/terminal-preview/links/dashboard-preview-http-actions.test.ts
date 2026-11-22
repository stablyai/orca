import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/store/testing/app-store-test-fixture'
import { useAppStore } from '@/store/index'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import { markHydratedBrowserPageHandles } from '@/store/slices/browser/hosts/browser-initialization-presentation-ownership'
import {
  seedBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN
} from '@/lib/browser/navigation/browser-link-open.test-fixture'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { dashboardPreviewHttpActions } from './dashboard-preview-http-actions'

vi.mock('@/components/browser-pane/host-guest/input/browser-focus', () => ({
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() })
}))

const initialState = useAppStore.getInitialState()
const openUrl = vi.fn<(url: string) => Promise<void>>()
let settingsSet: ReturnType<typeof vi.fn>

const SOURCE = { worktreeId: WORKSPACE, executionHostId: 'local', tabId: 'source', ptyId: 'pty-1' }

function resetStore(): void {
  useAppStore.setState(
    {
      ...initialState,
      remoteBrowserPageHandlesByPageId: markHydratedBrowserPageHandles({
        ...initialState.remoteBrowserPageHandlesByPageId
      })
    },
    true
  )
}

beforeEach(() => {
  openUrl.mockReset().mockResolvedValue(undefined)
  const api = createStoreCascadesMockApi()
  settingsSet = vi.fn(async (updates: Partial<GlobalSettings>) => ({
    ...useAppStore.getState().settings!,
    ...updates
  }))
  Object.assign(api, {
    shell: { openUrl },
    settings: {
      ...api.settings,
      set: settingsSet,
      get: vi.fn(async () => useAppStore.getState().settings)
    }
  })
  resetStore()
  seedBrowserLinkTestStore(useAppStore)
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/test'), httpLinkClickBehavior: 'ask' },
    runtimeStatusByEnvironmentId: new Map()
  })
})
afterEach(() => resetStore())

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('dashboard preview link chooser', () => {
  it('offers Remember in the main window and saves the system browser once it opens', async () => {
    const actions = dashboardPreviewHttpActions(SOURCE, URL_TO_OPEN, () => {})!
    expect(actions.rememberEligible).toBe(true)
    const system = actions.primary.rememberAs === 'system' ? actions.primary : actions.alternate!
    await system.run({ remember: true })
    await settle()
    expect(openUrl).toHaveBeenCalledWith(URL_TO_OPEN)
    expect(settingsSet).toHaveBeenCalledWith({
      openLinksInApp: false,
      httpLinkClickBehavior: 'open',
      openLinksInAppPreferencePrompted: true
    })
  })

  it('offers only the system browser and no Remember in the popout', () => {
    const actions = dashboardPreviewHttpActions(SOURCE, URL_TO_OPEN)!
    expect(actions.canOpen).toBe(false)
    expect(actions.destinations).toEqual({ primary: 'system' })
    expect(actions.rememberEligible).toBe(false)
  })

  it('offers no Remember once links already open directly', () => {
    useAppStore.setState({
      settings: { ...useAppStore.getState().settings!, httpLinkClickBehavior: 'open' }
    })
    expect(dashboardPreviewHttpActions(SOURCE, URL_TO_OPEN, () => {})!.rememberEligible).toBe(false)
  })

  it('saves nothing when the Orca browser can no longer open the link at action time', async () => {
    const actions = dashboardPreviewHttpActions(SOURCE, URL_TO_OPEN, () => {})!
    const orca = actions.primary.rememberAs === 'orca' ? actions.primary : actions.alternate!
    useAppStore.setState({ worktreesByRepo: {} })
    await orca.run({ remember: true })
    await settle()
    expect(settingsSet).not.toHaveBeenCalled()
  })
})
