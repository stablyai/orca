import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  restageWebRuntimeBrowserTabHostingIntent,
  type StagedWebRuntimeBrowserTab
} from './web-runtime-browser-tab-staging'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn()
}))

vi.mock('../store', () => ({ useAppStore: { getState: mocks.getState } }))

const ENVIRONMENT_ID = 'web-env-1'
const REMOTE_PAGE_ID = 'remote-page-1'
const STAGED: StagedWebRuntimeBrowserTab = {
  workspaceId: 'workspace-1',
  pageId: 'page-1',
  clientHosted: false
}

function stubStore(handle: Record<string, unknown> | undefined): void {
  mocks.getState.mockReturnValue({
    remoteBrowserPageHandlesByPageId: handle ? { [STAGED.pageId]: handle } : {},
    setRemoteBrowserPageHandle: mocks.setRemoteBrowserPageHandle
  })
}

describe('restageWebRuntimeBrowserTabHostingIntent', () => {
  beforeEach(() => {
    mocks.getState.mockReset()
    mocks.setRemoteBrowserPageHandle.mockReset()
  })

  it('marks the handle client-hosted when the live placement disagrees with the prediction', () => {
    stubStore({ staged: true, environmentId: ENVIRONMENT_ID, remotePageId: REMOTE_PAGE_ID })

    const next = restageWebRuntimeBrowserTabHostingIntent(STAGED, {
      environmentId: ENVIRONMENT_ID,
      remotePageId: REMOTE_PAGE_ID,
      clientHosted: true
    })

    expect(next).toEqual({ ...STAGED, clientHosted: true })
    expect(mocks.setRemoteBrowserPageHandle).toHaveBeenCalledWith(STAGED.pageId, {
      environmentId: ENVIRONMENT_ID,
      remotePageId: REMOTE_PAGE_ID,
      staged: true,
      stagedClientHosted: true
    })
  })

  it('drops the client-hosted mark when the live placement went the other way', () => {
    stubStore({
      staged: true,
      environmentId: ENVIRONMENT_ID,
      remotePageId: REMOTE_PAGE_ID,
      stagedClientHosted: true
    })

    const next = restageWebRuntimeBrowserTabHostingIntent(
      { ...STAGED, clientHosted: true },
      { environmentId: ENVIRONMENT_ID, remotePageId: REMOTE_PAGE_ID, clientHosted: false }
    )

    expect(next).toEqual({ ...STAGED, clientHosted: false })
    expect(mocks.setRemoteBrowserPageHandle).toHaveBeenCalledWith(STAGED.pageId, {
      environmentId: ENVIRONMENT_ID,
      remotePageId: REMOTE_PAGE_ID,
      staged: true
    })
  })

  it('leaves an agreeing prediction alone rather than rewriting its handle', () => {
    stubStore({ staged: true, environmentId: ENVIRONMENT_ID, remotePageId: REMOTE_PAGE_ID })

    const next = restageWebRuntimeBrowserTabHostingIntent(STAGED, {
      environmentId: ENVIRONMENT_ID,
      remotePageId: REMOTE_PAGE_ID,
      clientHosted: false
    })

    expect(next).toBe(STAGED)
    expect(mocks.setRemoteBrowserPageHandle).not.toHaveBeenCalled()
  })

  it('leaves an adopted handle alone — the snapshot owns those rows now', () => {
    stubStore({ environmentId: ENVIRONMENT_ID, remotePageId: REMOTE_PAGE_ID })

    const next = restageWebRuntimeBrowserTabHostingIntent(STAGED, {
      environmentId: ENVIRONMENT_ID,
      remotePageId: REMOTE_PAGE_ID,
      clientHosted: true
    })

    expect(next).toBe(STAGED)
    expect(mocks.setRemoteBrowserPageHandle).not.toHaveBeenCalled()
  })
})
