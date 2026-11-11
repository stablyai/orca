import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildBrowserPage,
  buildWorkspaceFromPage
} from '@/store/slices/browser/pages/browser-page-records'
import { browserLinkPageMatches, selectBrowserLinkDestination } from './browser-link-destination'
import {
  browserLinkTestDestination,
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN
} from './browser-link-open.test-fixture'
import type { BrowserLinkTestStore } from './browser-link-open.test-fixture'
import { captureLinkOpenIntent } from '../../links/placement/link-open-intent'
import '@/store/testing/app-store-test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import '@/store/slices/worktrees/worktree.test-fixture'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import './http-link-in-group-availability'
import { getDefaultSettings } from '../../../../../shared/constants'

let store: BrowserLinkTestStore
beforeEach(() => {
  store = createBrowserLinkTestStore()
})

describe('browser destination scope', () => {
  it('refuses hostless folder twins despite an active host selection', () => {
    const workspaceId = 'folder:legacy'
    store.setState((state) => ({
      activeWorktreeId: workspaceId,
      folderWorkspaces: [
        makeFolderWorkspace({ id: 'legacy', executionHostId: 'local' }),
        makeFolderWorkspace({ id: 'legacy', executionHostId: 'runtime:other' })
      ],
      unifiedTabsByWorktree: {
        [workspaceId]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
          ...tab,
          worktreeId: workspaceId,
          executionHostId: undefined
        }))
      },
      groupsByWorktree: { [workspaceId]: state.groupsByWorktree[WORKSPACE]! },
      layoutByWorktree: { [workspaceId]: state.layoutByWorktree[WORKSPACE]! }
    }))
    const state = store.getState()
    expect(
      selectBrowserLinkDestination(
        state,
        browserLinkTestDestination({ worktreeId: workspaceId }),
        captureLinkOpenIntent(state, workspaceId, 'source', { explicitSourceGroup: true })
      )
    ).toEqual({ status: 'refused' })
  })

  it('compares effective partition and profile without changing the existing profile', () => {
    const page = buildBrowserPage('browser', WORKSPACE, URL_TO_OPEN, undefined, null)
    const workspace = buildWorkspaceFromPage('browser', WORKSPACE, page, [page.id], null)
    const state = store.getState()
    const destination = browserLinkTestDestination()
    expect(browserLinkPageMatches(state, destination, workspace, page)).toBe(true)
    expect(
      browserLinkPageMatches(
        state,
        destination,
        { ...workspace, sessionProfileId: undefined },
        page
      )
    ).toBe(false)
    expect(
      browserLinkPageMatches(state, destination, { ...workspace, sessionProfileId: 'other' }, page)
    ).toBe(false)
    expect(
      browserLinkPageMatches(
        state,
        destination,
        { ...workspace, sessionPartition: 'persist:other-login' },
        page
      )
    ).toBe(false)
    expect(workspace.sessionProfileId).toBeNull()
  })

  it('does not equate credential requests through the redacted stored URL', () => {
    const raw = 'https://kagi.com/search?q=test&token=secret'
    const page = buildBrowserPage('browser', WORKSPACE, raw, undefined, null)
    const workspace = buildWorkspaceFromPage('browser', WORKSPACE, page, [page.id], null)
    expect(page.url).not.toContain('secret')
    expect(
      browserLinkPageMatches(
        store.getState(),
        browserLinkTestDestination({ resource: { kind: 'website', url: raw } }),
        workspace,
        page
      )
    ).toBe(false)
  })

  it('keeps local, SSH and runtime owners distinct even when URL or file text agrees', () => {
    const existing = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
      targetGroupId: 'b',
      executionHostId: 'ssh:another',
      browserRuntimeEnvironmentId: null,
      sessionProfileId: null,
      activate: false
    })
    const state = store.getState()
    const intent = captureLinkOpenIntent(state, WORKSPACE, 'source')
    expect(selectBrowserLinkDestination(state, browserLinkTestDestination(), intent)).toMatchObject(
      { match: null }
    )
    const page = state.browserPagesByWorkspace[existing.id]![0]!
    expect(
      browserLinkPageMatches(state, browserLinkTestDestination(), existing, {
        ...page,
        browserRuntimeEnvironmentId: 'other-runtime'
      })
    ).toBe(false)
  })

  it('does not let detached records or a browser wrapper outside the source layout attract placement', () => {
    const existing = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
      targetGroupId: 'c',
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      sessionProfileId: null,
      activate: false
    })
    const tabs = store.getState().unifiedTabsByWorktree[WORKSPACE]!
    store.setState({
      unifiedTabsByWorktree: { [WORKSPACE]: tabs.filter((tab) => tab.entityId !== existing.id) }
    })
    const intent = captureLinkOpenIntent(store.getState(), WORKSPACE, 'source')
    expect(
      selectBrowserLinkDestination(store.getState(), browserLinkTestDestination(), intent)
    ).toMatchObject({ groupId: 'b', match: null })
    store.setState({
      unifiedTabsByWorktree: {
        [WORKSPACE]: [
          ...store.getState().unifiedTabsByWorktree[WORKSPACE]!,
          makeUnifiedTab({
            id: 'detached',
            entityId: existing.id,
            worktreeId: WORKSPACE,
            groupId: 'missing',
            contentType: 'browser',
            executionHostId: 'local'
          })
        ]
      }
    })
    expect(
      selectBrowserLinkDestination(store.getState(), browserLinkTestDestination(), intent)
    ).toMatchObject({ groupId: 'b', match: null })
  })

  it('requires doc ownership and path identity, excluding current website URLs on mixed containers', () => {
    const docLocation = {
      kind: 'workspace-doc' as const,
      worktreeId: WORKSPACE,
      filePath: '/repo/doc.html'
    }
    const page = buildBrowserPage(
      'browser',
      WORKSPACE,
      URL_TO_OPEN,
      undefined,
      null,
      undefined,
      docLocation
    )
    const workspace = buildWorkspaceFromPage('browser', WORKSPACE, page, [page.id], null)
    expect(
      browserLinkPageMatches(store.getState(), browserLinkTestDestination(), workspace, page)
    ).toBe(false)
    expect(
      browserLinkPageMatches(
        store.getState(),
        browserLinkTestDestination({ resource: { kind: 'document', docLocation } }),
        workspace,
        page
      )
    ).toBe(true)
    expect(
      browserLinkPageMatches(
        store.getState(),
        browserLinkTestDestination({
          resource: {
            kind: 'document',
            docLocation: { ...docLocation, filePath: '/repo/DOC.html' }
          }
        }),
        workspace,
        page
      )
    ).toBe(false)
  })
})

describe('browser destination split preference', () => {
  it('opens a tab in the lone source pane instead of splitting when splits are off', () => {
    store.setState((state) => ({
      settings: { ...getDefaultSettings('/home/dev'), openLinksInAppInSplit: false },
      groupsByWorktree: { [WORKSPACE]: state.groupsByWorktree[WORKSPACE]!.slice(0, 1) },
      unifiedTabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.slice(0, 1)
      },
      activeGroupIdByWorktree: { [WORKSPACE]: 'a' },
      layoutByWorktree: { [WORKSPACE]: { type: 'leaf', groupId: 'a' } }
    }))
    const state = store.getState()
    expect(
      selectBrowserLinkDestination(
        state,
        browserLinkTestDestination(),
        captureLinkOpenIntent(state, WORKSPACE, 'source')
      )
    ).toEqual({ status: 'ready', groupId: 'a', match: null })
  })
})
