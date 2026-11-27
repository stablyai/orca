// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshots/snapshot-api'
import {
  makeSnapshot,
  makeState,
  NOW
} from '@/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'
import { useAppStore } from '@/store/index'
import type {
  BrowserBookmarks,
  BrowserBookmarksApi
} from '../../../../../shared/browser/bookmarks/browser-bookmarks'
import { BrowserBookmarkStar } from './BrowserBookmarkStar'
import { BrowserNewTabBookmarks } from './BrowserNewTabBookmarks'
import { installBrowserBookmarks } from './browser-bookmark-state'

vi.mock('@/store/index', async () => {
  const { create } = await import('zustand')
  return { useAppStore: create(() => ({})) }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('keeps a host-confirmed browser profile separate from the runtime default collection', async () => {
  const url = 'https://example.org/project'
  const state = applyWebSessionTabsSnapshot(
    makeState(),
    makeSnapshot([
      {
        type: 'browser',
        id: 'host-tab',
        browserWorkspaceId: 'mirrored-workspace',
        browserPageId: 'mirrored-page',
        browserProfileId: 'project-profile',
        title: 'Project notes',
        url,
        placement: {
          kind: 'client',
          browserHostClientId: 'desktop-client',
          browserHostGeneration: 1,
          pageHostGeneration: 1
        },
        loading: false,
        canGoBack: false,
        canGoForward: false,
        isActive: false
      }
    ]),
    'lab',
    NOW
  )
  useAppStore.setState(state)

  const defaultCollection: BrowserBookmarks = {
    '["runtime:lab","default"]': [
      {
        id: 'd1208eb4-9769-4c8c-a278-4dc4030c384d',
        title: 'Default collection',
        url: 'https://example.com/'
      }
    ]
  }
  const projectBookmark = {
    id: '0b339b8e-bf94-457a-889b-8f13911ebc93',
    title: 'Project bookmark',
    url
  }
  let publish: Parameters<BrowserBookmarksApi['onChanged']>[0] | undefined
  const mutate = vi.fn<BrowserBookmarksApi['mutate']>().mockResolvedValue('saved')
  const api: BrowserBookmarksApi = {
    list: async () => ({
      ...defaultCollection,
      '["runtime:lab","project-profile"]': [projectBookmark]
    }),
    mutate,
    onChanged: (callback) => {
      publish = callback
      return () => {
        publish = undefined
      }
    }
  }
  vi.stubGlobal('api', { browser: { bookmarks: api } })
  const uninstall = installBrowserBookmarks()
  try {
    render(
      <TooltipProvider>
        <BrowserBookmarkStar pageId="mirrored-page" />
        <BrowserNewTabBookmarks pageId="mirrored-page" onOpenUrl={vi.fn()} />
      </TooltipProvider>
    )
    const star = await screen.findByRole('button', { name: 'Bookmark this page' })
    expect(screen.getByText('Project bookmark')).toBeTruthy()
    expect(screen.queryByText('Default collection')).toBeNull()
    await act(async () => {
      fireEvent.click(star)
    })
    expect(mutate).toHaveBeenLastCalledWith(['runtime:lab', 'project-profile'], {
      kind: 'remove',
      id: projectBookmark.id
    })
    act(() => publish?.(defaultCollection))
    await act(async () => {
      fireEvent.click(star)
    })
    expect(mutate).toHaveBeenLastCalledWith(['runtime:lab', 'project-profile'], {
      kind: 'add',
      title: 'Project notes',
      url
    })
  } finally {
    uninstall()
  }
})
