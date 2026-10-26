import { beforeEach, describe, expect, it } from 'vitest'
import { buildBrowserPage, buildWorkspaceFromPage } from '@/store/slices/browser-page-records'
import {
  browserLinkPageMatches,
  browserLinkUrlIdentity,
  browserOpenResultForPage,
  selectBrowserLinkDestination
} from './browser-link-destination'
import {
  browserLinkTestDestination,
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN,
  type BrowserLinkTestStore
} from './browser-link-open.test-fixture'
import { captureLinkOpenIntent } from './link-open-intent'
import { makeUnifiedTab, makeWorktree } from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { canOfferHttpLinkGroupAction } from './http-link-in-group-availability'

let store: BrowserLinkTestStore
beforeEach(() => {
  store = createBrowserLinkTestStore()
})

it('normalizes only explicit HTTP URLs and keeps path, query and fragment identity', () => {
  expect(browserLinkUrlIdentity('https://EXAMPLE.com:443')).toBe('https://example.com/')
  for (const input of [
    'example.com',
    'search words',
    'file:///tmp/a.html',
    'javascript:alert(1)',
    'https://user:password@example.com/',
    'https://kagi.com/search?token=secret&q=a'
  ]) {
    expect(browserLinkUrlIdentity(input)).toBeNull()
  }
  const identities = ['/a', '/a/', '/A', '/a?a=1&b=2', '/a?b=2&a=1', '/a#one', '/a#two'].map(
    (path) => browserLinkUrlIdentity(`https://example.com${path}`)
  )
  expect(new Set(identities).size).toBe(identities.length)
  expect(browserLinkUrlIdentity('http://localhost:3000')).not.toBe(
    browserLinkUrlIdentity('http://127.0.0.1:3000')
  )
})

describe('browser destination scope', () => {
  it.each([
    ['worktree', 'local', undefined, 'local'],
    ['worktree', 'ssh:target', undefined, 'ssh:target'],
    ['worktree', 'runtime:server', undefined, 'runtime:server'],
    ['worktree', 'ssh:target', 'server', 'ssh:target'],
    ['worktree', 'ssh:target', 'server', 'runtime:server'],
    ['folder', 'local', undefined, 'local'],
    ['folder', 'runtime:server', undefined, 'runtime:server']
  ] as const)(
    'places a hostless %s source owned by %s (%s) on %s',
    (kind, hostId, runtimeOwner, destinationHostId) => {
      const workspaceId = kind === 'folder' ? 'folder:legacy' : WORKSPACE
      store.setState((state) => ({
        activeWorktreeId: workspaceId,
        activeWorkspaceExecutionHostId: hostId,
        worktreesByRepo: {
          repo1: [
            makeWorktree({
              id: WORKSPACE,
              repoId: 'repo1',
              hostId,
              runtimeOwnerEnvironmentId: runtimeOwner
            })
          ]
        },
        folderWorkspaces: [makeFolderWorkspace({ id: 'legacy', executionHostId: hostId })],
        unifiedTabsByWorktree: {
          [workspaceId]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
            ...tab,
            worktreeId: workspaceId,
            executionHostId: undefined
          }))
        },
        groupsByWorktree: { [workspaceId]: state.groupsByWorktree[WORKSPACE]! },
        layoutByWorktree: { [workspaceId]: state.layoutByWorktree[WORKSPACE]! },
        activeGroupIdByWorktree: { [workspaceId]: 'c' }
      }))
      const state = store.getState()
      expect(
        selectBrowserLinkDestination(
          state,
          browserLinkTestDestination({
            worktreeId: workspaceId,
            executionHostId: destinationHostId
          }),
          captureLinkOpenIntent(state, workspaceId, 'source')
        )
      ).toMatchObject({
        status: 'ready',
        split: { sourceGroupId: 'a', splitDirection: 'right' },
        match: null
      })
    }
  )

  it('places hostless sources beside their group and reuses hostless browser wrappers', () => {
    const existing = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
      targetGroupId: 'b',
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      sessionProfileId: null,
      activate: false
    })
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
          ...tab,
          executionHostId: undefined
        }))
      }
    }))
    const state = store.getState()
    const intent = captureLinkOpenIntent(state, WORKSPACE, 'source')
    const destination = browserLinkTestDestination()
    expect(selectBrowserLinkDestination(state, destination, intent)).toMatchObject({
      status: 'ready',
      groupId: 'b',
      match: { browserWorkspaceId: existing.id, browserPageId: existing.activePageId }
    })
    expect(
      browserOpenResultForPage(state, destination, existing.id, existing.activePageId!)
    ).toMatchObject({ groupId: 'b', browserWorkspaceId: existing.id })

    store.setState({ browserTabsByWorktree: {} })
    expect(selectBrowserLinkDestination(store.getState(), destination, intent)).toMatchObject({
      status: 'ready',
      split: { sourceGroupId: 'a', splitDirection: 'right' },
      match: null
    })
  })

  it.each(['listed', 'detected'] as const)(
    'refuses hostless ownership for %s twins even when the active workspace names one host',
    (catalog) => {
      const existing = store.getState().createBrowserTab(WORKSPACE, URL_TO_OPEN, {
        targetGroupId: 'b',
        executionHostId: 'local',
        browserRuntimeEnvironmentId: null,
        sessionProfileId: null,
        activate: false
      })
      store.setState((state) => ({
        ...(catalog === 'listed'
          ? {
              worktreesByRepo: {
                repo1: [
                  ...state.worktreesByRepo.repo1!,
                  makeWorktree({ id: WORKSPACE, repoId: 'repo1', hostId: 'runtime:other' })
                ]
              }
            }
          : {
              detectedWorktreesByRepo: {
                repo1: {
                  repoId: 'repo1',
                  authoritative: true,
                  source: 'git' as const,
                  worktrees: [
                    {
                      ...makeWorktree({ id: WORKSPACE, repoId: 'repo1', hostId: 'runtime:other' }),
                      ownership: 'external' as const,
                      selectedCheckout: false,
                      visible: true
                    }
                  ]
                }
              }
            }),
        unifiedTabsByWorktree: {
          [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
            ...tab,
            executionHostId: undefined
          }))
        }
      }))
      const state = store.getState()
      const destination = browserLinkTestDestination()
      expect(
        selectBrowserLinkDestination(
          state,
          destination,
          captureLinkOpenIntent(state, WORKSPACE, 'source')
        )
      ).toMatchObject({ status: 'ready', split: { sourceGroupId: 'c' }, match: null })
      expect(
        browserOpenResultForPage(state, destination, existing.id, existing.activePageId!)
      ).toBeNull()
      expect(
        canOfferHttpLinkGroupAction(state, {
          workspaceId: WORKSPACE,
          sourceTabId: 'source',
          sourceOwner: { kind: 'local' },
          url: URL_TO_OPEN
        })
      ).toBe(false)
      expect(
        selectBrowserLinkDestination(
          state,
          browserLinkTestDestination(),
          captureLinkOpenIntent(state, WORKSPACE, 'source', { explicitSourceGroup: true })
        )
      ).toEqual({ status: 'refused' })
    }
  )

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
    ).toMatchObject({ split: { sourceGroupId: 'a' }, match: null })
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
    ).toMatchObject({ split: { sourceGroupId: 'a' }, match: null })
  })

  it('uses a visible browser and splits beside the source when that browser becomes hidden', () => {
    const existing = store.getState().createBrowserTab(WORKSPACE, 'https://unrelated.example/', {
      targetGroupId: 'a',
      executionHostId: 'local',
      browserRuntimeEnvironmentId: null,
      activate: true
    })
    store.setState((state) => ({
      unifiedTabsByWorktree: {
        [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) =>
          tab.id === 'source' ? { ...tab, groupId: 'b' } : tab
        )
      }
    }))
    const intent = captureLinkOpenIntent(store.getState(), WORKSPACE, 'source')
    expect(
      selectBrowserLinkDestination(store.getState(), browserLinkTestDestination(), intent)
    ).toMatchObject({ groupId: 'a', match: null })
    store.setState((state) => ({
      groupsByWorktree: {
        [WORKSPACE]: state.groupsByWorktree[WORKSPACE]!.map((group) =>
          group.id === 'a' ? { ...group, activeTabId: 'source' } : group
        )
      }
    }))
    expect(
      selectBrowserLinkDestination(store.getState(), browserLinkTestDestination(), intent)
    ).toMatchObject({ split: { sourceGroupId: 'b' }, match: null })
    expect(
      store
        .getState()
        .browserTabsByWorktree[WORKSPACE]?.some((workspace) => workspace.id === existing.id)
    ).toBe(true)
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
