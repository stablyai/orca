// @vitest-environment happy-dom
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { NativeChatInlineVisual } from './NativeChatInlineVisual'
import { NativeChatVisualOwnerProvider, useNativeChatVisualOwner } from './native-chat-visual-owner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { seedBrowserLinkTestStore, WORKSPACE } from '@/lib/browser-link-open.test-fixture'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'

vi.mock('./use-native-chat-visual-document', () => ({
  useNativeChatVisualDocument: () => ({
    status: 'ready',
    document: { path: '/repo/chart.html', revision: '1', html: '<p>chart</p>' }
  })
}))
vi.mock('./NativeChatTranscriptChrome', () => ({
  observeTranscriptVisibility: (_element: Element, visible: (value: boolean) => void) => {
    visible(true)
    return () => {}
  }
}))
vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
const domWindow = window
const api = createStoreCascadesMockApi()
vi.stubGlobal('window', domWindow)
Object.defineProperty(domWindow, 'api', { value: api, configurable: true })

afterEach(cleanup)
beforeEach(() => {
  seedBrowserLinkTestStore(useAppStore)
  useAppStore.setState((state) => ({
    unifiedTabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
        tab.id === 'source' ? { ...tab, contentType: 'agent-session' as const } : tab
      )
    }
  }))
})

function OwnedVisual() {
  const owner = useNativeChatVisualOwner()
  return owner ? <NativeChatInlineVisual owner={owner} file="chart.html" title="Chart" /> : null
}
function showVisual() {
  render(
    <TooltipProvider>
      <NativeChatVisualOwnerProvider target={{ kind: 'local' }} sessionId="session" tabId="source">
        <OwnedVisual />
      </NativeChatVisualOwnerProvider>
    </TooltipProvider>
  )
}
function wrapperForActiveBrowser() {
  const state = useAppStore.getState()
  return state.unifiedTabsByWorktree[WORKSPACE]?.find(
    (tab) => tab.entityId === state.activeBrowserTabIdByWorktree[WORKSPACE]
  )
}

it('the visible button opens beside its owning chat even while another group has focus', () => {
  showVisual()
  fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }))
  const groupId = wrapperForActiveBrowser()?.groupId
  expect(groupId).toBeTruthy()
  expect(['a', 'b', 'c']).not.toContain(groupId)
  expect(useAppStore.getState().layoutByWorktree[WORKSPACE]).toMatchObject({
    first: { type: 'split', first: { groupId: 'a' }, second: { groupId } }
  })
  expect(
    useAppStore.getState().groupsByWorktree[WORKSPACE]?.find((group) => group.id === 'a')
      ?.activeTabId
  ).toBe('source')
  expect(screen.getByRole('button', { name: 'Open in new tab' })).toBeTruthy()
})

it('the button follows a moved source and reuses the exact inactive page', () => {
  const browser = useAppStore.getState().createBrowserTab(WORKSPACE, 'file:///repo/chart.html', {
    targetGroupId: 'c',
    executionHostId: 'local',
    browserRuntimeEnvironmentId: null,
    activate: false
  })
  useAppStore.getState().createBrowserPage(browser.id, 'https://other.example/', {
    activate: true,
    browserRuntimeEnvironmentId: null
  })
  showVisual()
  act(() => {
    useAppStore.setState((state) => ({
      unifiedTabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
          tab.id === 'source' ? { ...tab, groupId: 'b' } : tab
        )
      }
    }))
  })
  fireEvent.click(screen.getByRole('button', { name: 'Open in new tab' }))
  expect(wrapperForActiveBrowser()?.entityId).toBe(browser.id)
  expect(wrapperForActiveBrowser()?.groupId).toBe('c')
  expect(
    useAppStore.getState().browserTabsByWorktree[WORKSPACE]?.find((tab) => tab.id === browser.id)
      ?.activePageId
  ).toBe(browser.activePageId)
})
