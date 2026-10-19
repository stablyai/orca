// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  noticePage,
  noticeWorktree,
  noticeWorkspace,
  seedBrowserNotice
} from './native-chat-browser-notice.test-support'

const mocks = vi.hoisted(() => ({
  observed: ['page-1', 'page-2'],
  activateAndRevealWorkspace: vi.fn(() => true),
  openRoutedHttpLink: vi.fn()
}))
vi.mock('@/lib/browser-automation-activity', () => ({
  useBrowserAutomationPageIds: () => mocks.observed
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: mocks.activateAndRevealWorkspace
}))
vi.mock('@/lib/http-link-destinations', () => ({
  openRoutedHttpLink: mocks.openRoutedHttpLink
}))

import { NativeChatBrowserNotice } from './NativeChatBrowserNotice'

beforeEach(() => {
  vi.clearAllMocks()
  seedBrowserNotice({
    browserTabsByWorktree: {
      'worktree-1': [noticeWorkspace({ pageIds: ['page-1', 'page-2'] })]
    },
    browserPagesByWorkspace: {
      'browser-1': [
        noticePage(),
        noticePage({ id: 'page-2', title: 'Second page', url: 'https://example.com/second' })
      ]
    }
  })
})
afterEach(cleanup)

describe('NativeChatBrowserNotice', () => {
  it('announces the browser without changing focus, and reveals the exact selected page on click', () => {
    render(<NativeChatBrowserNotice tabId="chat-1" />)
    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeBrowserTabId).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: 'Show in Orca' })[1])

    const state = useAppStore.getState()
    expect(state.activeBrowserTabId).toBe('browser-1')
    expect(state.browserTabsByWorktree['worktree-1'][0].activePageId).toBe('page-2')
    expect(state.groupsByWorktree['worktree-1'][0].activeTabId).toBe('browser-tab')
    expect(mocks.openRoutedHttpLink).not.toHaveBeenCalled()
  })

  it('keeps external opening explicit and separate from revealing the existing Orca page', () => {
    render(<NativeChatBrowserNotice tabId="chat-1" />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Open site in default browser' })[1])

    expect(mocks.openRoutedHttpLink).toHaveBeenCalledExactlyOnceWith('https://example.com/second', {
      worktreeId: 'worktree-1',
      sourceOwner: { kind: 'local' },
      forceDestination: 'system'
    })
    expect(mocks.activateAndRevealWorkspace).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeBrowserTabId).toBeNull()
  })

  it('removes a closed page and never offers an external handoff for document pages', () => {
    useAppStore.setState({
      browserPagesByWorkspace: {
        'browser-1': [noticePage({ url: 'file:///tmp/report.html' })]
      }
    })
    render(<NativeChatBrowserNotice tabId="chat-1" />)
    expect(screen.getByRole('button', { name: 'Show in Orca' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Open site in default browser' })).toBeNull()
    act(() => useAppStore.setState({ browserPagesByWorkspace: {} }))
    expect(screen.queryByRole('button', { name: 'Show in Orca' })).toBeNull()
  })

  it.each(['runtime:server', 'ssh:host'] as const)(
    'offers only the existing Orca page for loopback sites on %s',
    (hostId) => {
      seedBrowserNotice({
        worktreesByRepo: { 'repo-1': [noticeWorktree({ hostId })] },
        browserPagesByWorkspace: {
          'browser-1': [noticePage({ url: 'http://localhost:3000/' })]
        }
      })
      render(<NativeChatBrowserNotice tabId="chat-1" />)
      expect(screen.getByRole('button', { name: 'Show in Orca' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Open site in default browser' })).toBeNull()
      expect(mocks.openRoutedHttpLink).not.toHaveBeenCalled()
    }
  )

  it('keeps a notice visible when activity has stopped and the view remounts', () => {
    const first = render(<NativeChatBrowserNotice tabId="chat-1" />)
    expect(screen.getAllByRole('button', { name: 'Show in Orca' })).toHaveLength(2)
    first.unmount()
    render(<NativeChatBrowserNotice tabId="chat-1" />)
    expect(screen.getAllByRole('button', { name: 'Show in Orca' })).toHaveLength(2)
  })
})
