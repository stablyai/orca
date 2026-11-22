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
import type { LinkActionRequest } from '@/components/link-actions/link-action-request'
import { resolveNativeChatHttpLinkRouting } from './native-chat-link-target-actions'
import { handleNativeChatWebLink } from './native-chat-web-link-actions'

vi.mock('@/components/browser-pane/host-guest/input/browser-focus', () => ({
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), dismiss: vi.fn() })
}))

const initialState = useAppStore.getInitialState()
const openUrl = vi.fn<(url: string) => Promise<void>>()
let settingsSet: ReturnType<typeof vi.fn>

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

function plainClick(mode: 'ask' | 'open', rememberHost = true): LinkActionRequest | null {
  let requested: LinkActionRequest | null = null
  const state = useAppStore.getState()
  handleNativeChatWebLink(
    {
      altKey: false,
      clientX: 0,
      clientY: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      preventDefault: () => {}
    },
    URL_TO_OPEN,
    {
      worktreeId: WORKSPACE,
      sourceTabId: 'source',
      ...resolveNativeChatHttpLinkRouting(state, WORKSPACE),
      actionsEnabled: mode === 'ask',
      ...(rememberHost ? { rememberHost: { mode } } : {}),
      restoreFocus: () => {},
      request: (request) => {
        requested = request
      }
    }
  )
  return requested
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('Remember from the chat chooser', () => {
  it('offers Remember for a plain click in Ask with both browsers', () => {
    expect(plainClick('ask')).toMatchObject({ rememberEligible: true, linkPreferenceHost: true })
  })

  it('saves the chosen browser only after the open is admitted', async () => {
    const request = plainClick('ask')!
    const system = request.primary.rememberAs === 'system' ? request.primary : request.alternate!
    await system.run({ remember: true })
    await settle()
    expect(openUrl).toHaveBeenCalledWith(URL_TO_OPEN)
    expect(settingsSet).toHaveBeenCalledWith({
      openLinksInApp: false,
      httpLinkClickBehavior: 'open',
      openLinksInAppPreferencePrompted: true
    })
    expect(useAppStore.getState().settings).toMatchObject({ httpLinkClickBehavior: 'open' })
  })

  it('saves nothing when the open fails', async () => {
    openUrl.mockRejectedValueOnce(new Error('denied'))
    const request = plainClick('ask')!
    const system = request.primary.rememberAs === 'system' ? request.primary : request.alternate!
    await system.run({ remember: true })
    await settle()
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('saves nothing when the box is not ticked', async () => {
    const request = plainClick('ask')!
    await request.primary.run({ remember: false })
    await settle()
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('keeps the sidebar and activity chooser without Remember, and a ticked row saves nothing', async () => {
    const request = plainClick('ask', false)!
    expect(request.rememberEligible).toBeUndefined()
    expect(request.linkPreferenceHost).toBeUndefined()
    const system = request.primary.rememberAs === 'system' ? request.primary : request.alternate!
    await system.run({ remember: true })
    await settle()
    expect(openUrl).toHaveBeenCalledWith(URL_TO_OPEN)
    expect(settingsSet).not.toHaveBeenCalled()
  })

  it('opens the saved browser directly in Open mode, with no chooser', async () => {
    expect(plainClick('open')).toBeNull()
    await settle()
    expect(openUrl).toHaveBeenCalledWith(URL_TO_OPEN)
  })
})
