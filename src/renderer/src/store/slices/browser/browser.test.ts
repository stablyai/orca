import { describe, expect, it, vi } from 'vitest'

import {
  GRAB_BUDGET,
  type BrowserPageAnnotation
} from '../../../../../shared/browser/element-grab/browser-grab-types'
import { makeAnnotation } from './annotations/browser-annotation-test-fixture'
import { getDefaultSettings } from '../../../../../shared/constants'
import '../../../../../shared/workspace-layout/layout-owner-switch'
import type { BrowserSessionProfile } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { ManagedBrowserProfileOwner } from '../../../../../shared/browser/profiles/browser-profile-scope'
import '@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture'
import { createBrowserMockApi } from './browser-slice-test-harness'
import { createTestStoreDrawnFromMain } from './browser-slice-drawn-from-main.test-fixture'

const createWebRuntimeSessionBrowserTabMock = vi.hoisted(() => vi.fn())
const runtimeEnvironmentTransportCall = vi.fn()

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/runtime/browser/creation/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: createWebRuntimeSessionBrowserTabMock
}))

const mockApi = createBrowserMockApi(runtimeEnvironmentTransportCall)

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

describe('createBrowserSlice annotations', () => {
  it('keeps a requested canonical page identity distinct from its workspace', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'about:blank', {
      browserPageId: 'page-canonical'
    })
    await main.settle()

    expect(tab.id).not.toBe('page-canonical')
    expect(tab.activePageId).toBe('page-canonical')
    expect(store.getState().browserPagesByWorkspace[tab.id]?.[0]?.id).toBe('page-canonical')
    expect(() =>
      store.getState().createBrowserTab('wt-1', 'about:blank', {
        browserPageId: 'page-canonical'
      })
    ).toThrow('Browser page page-canonical already exists')
  })

  it('keeps certificate challenges transient across navigation, success, and close', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://localhost:3443/')
    await main.settle()
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    const failure = {
      challengeId: 'challenge-1',
      browserPageId: pageId,
      errorCode: -202,
      error: 'ERR_CERT_AUTHORITY_INVALID',
      origin: 'https://localhost:3443',
      displayHost: 'localhost:3443',
      canProceed: true,
      observedAt: 123
    }

    store.getState().setBrowserPageCertificateFailure(pageId, failure)
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toEqual(failure)

    store.getState().setBrowserPageUrl(pageId, 'https://localhost:3443/next')
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()

    store.getState().setBrowserPageCertificateFailure(pageId, failure)
    store.getState().updateBrowserPageState(pageId, { loadError: null })
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()

    store.getState().setBrowserPageCertificateFailure(pageId, failure)
    store.getState().closeBrowserTab(tab.id)
    await main.settle()
    expect(store.getState().browserCertificateFailuresByPageId[pageId]).toBeUndefined()
  })

  it('gives each repo its own profile under the per-repo scope and holds pages until main has it', async () => {
    const created = new Map<string, (profile: BrowserSessionProfile) => void>()
    const ensureMock = vi.fn(
      ({ owner }: { owner: ManagedBrowserProfileOwner }) =>
        new Promise<BrowserSessionProfile>((resolve) => created.set(owner.id, resolve))
    )
    Object.assign(mockApi.browser, { sessionEnsureManagedProfile: ensureMock })
    const { store, main } = await createTestStoreDrawnFromMain({
      repos: [],
      settings: {
        ...getDefaultSettings('/tmp'),
        browserProfileScope: 'repo',
        browserDefaultProfileIdByHostId: { local: 'user-default' }
      }
    })

    const first = store.getState().createBrowserTab('repo-a::/a/one', 'about:blank')
    const sibling = store.getState().createBrowserTab('repo-a::/a/two', 'about:blank')
    const other = store.getState().createBrowserTab('repo-b::/b/one', 'about:blank')
    await main.settle()

    const placeholderId = first.sessionProfileId ?? ''
    expect(sibling.sessionProfileId).toBe(placeholderId)
    expect(other.sessionProfileId).not.toBe(placeholderId)
    expect(placeholderId).not.toBe('user-default')
    expect(ensureMock.mock.calls.map(([args]) => args.owner)).toEqual([
      { kind: 'repo', id: 'repo-a' },
      { kind: 'repo', id: 'repo-b' }
    ])
    expect(store.getState().managedBrowserProfileStatusById[placeholderId]).toBe('pending')
    // A placeholder that outlives this run must load nowhere, never on the shared Default jar.
    expect(first.sessionPartition).toBe(`persist:orca-browser-unminted-${placeholderId}`)
    store.getState().closeBrowserTab(sibling.id)
    await main.settle()

    const profile: BrowserSessionProfile = {
      id: 'minted-by-main',
      scope: 'isolated',
      partition: 'persist:orca-browser-session-minted-by-main',
      label: 'Repo: repo-a',
      source: null,
      owner: { kind: 'repo', id: 'repo-a' }
    }
    created.get('repo-a')?.(profile)
    await vi.waitFor(() =>
      expect(store.getState().managedBrowserProfileStatusById[placeholderId]).toBeUndefined()
    )
    // A tab closed while it waited reopens on the profile main made, not the placeholder.
    expect(store.getState().reopenClosedBrowserTab('repo-a::/a/two')).not.toBeNull()
    await main.settle()
    const repoATabs = ['repo-a::/a/one', 'repo-a::/a/two'].flatMap(
      (worktreeId) => store.getState().browserTabsByWorktree[worktreeId] ?? []
    )
    expect(repoATabs.map((tab) => tab.sessionPartition ?? null)).toEqual([null, null])
    expect(repoATabs.map((tab) => tab.sessionProfileId)).toEqual([
      'minted-by-main',
      'minted-by-main'
    ])
    expect(store.getState().browserSessionProfilesByHostId.local).toEqual([profile])

    const later = store.getState().createBrowserTab('repo-a::/a/three', 'about:blank')
    expect(later.sessionProfileId).toBe('minted-by-main')
    expect(store.getState().managedBrowserProfileStatusById['minted-by-main']).toBeUndefined()
  })

  it("opens new tabs on the repo's picked profile over the scope, until that profile is gone", async () => {
    const ensureMock = vi.fn(
      (_args: { owner: ManagedBrowserProfileOwner }) => new Promise<BrowserSessionProfile>(() => {})
    )
    Object.assign(mockApi.browser, { sessionEnsureManagedProfile: ensureMock })
    const profile = (id: string): BrowserSessionProfile => ({
      id,
      scope: id === 'default' ? 'default' : 'isolated',
      partition: `persist:${id}`,
      label: id,
      source: null
    })
    const repo = (id: string, browserProfileId: string) => ({
      id,
      path: `/${id}`,
      displayName: id,
      badgeColor: '#000000',
      addedAt: 0,
      browserProfileId
    })
    const { store, main } = await createTestStoreDrawnFromMain({
      repos: [
        repo('work', 'work-profile'),
        repo('plain', 'default'),
        repo('stale', 'deleted'),
        { ...repo('remote', 'work-profile'), connectionId: 'conn-1' }
      ],
      browserSessionProfilesByHostId: { local: [profile('default'), profile('work-profile')] },
      settings: { ...getDefaultSettings('/tmp'), browserProfileScope: 'repo' }
    })

    const work = store.getState().createBrowserTab('work::/work/one', 'about:blank')
    const plain = store.getState().createBrowserTab('plain::/plain/one', 'about:blank')
    const stale = store.getState().createBrowserTab('stale::/stale/one', 'about:blank')
    // Agent opens render an SSH workspace's page on this desktop, so they name the local host.
    const agentOnSsh = store.getState().createBrowserTab('remote::/remote/one', 'about:blank', {
      browserRuntimeEnvironmentId: null
    })
    await main.settle()

    expect(work.sessionProfileId).toBe('work-profile')
    expect(agentOnSsh.sessionProfileId).toBe('work-profile')
    expect(plain.sessionProfileId).toBeNull()
    expect(ensureMock.mock.calls.map(([args]) => args)).toEqual([
      expect.objectContaining({ owner: { kind: 'repo', id: 'stale' } })
    ])
    expect(stale.sessionProfileId).not.toBe('deleted')
  })

  it('sanitizes persistent annotation payloads at the store boundary', async () => {
    const { store, main } = await createTestStoreDrawnFromMain()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    await main.settle()
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    const annotation = makeAnnotation(pageId)
    const oversizedComment = 'a'.repeat(GRAB_BUDGET.annotationCommentMaxLength + 10)

    store.getState().addBrowserPageAnnotation({
      ...annotation,
      comment: oversizedComment,
      payload: {
        ...annotation.payload,
        screenshot: {
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,abc',
          width: 1,
          height: 1
        }
      } as unknown as BrowserPageAnnotation['payload']
    })

    const stored = store.getState().browserAnnotationsByPageId[pageId]?.[0]
    expect(stored?.payload.screenshot).toBeNull()
  })
})
