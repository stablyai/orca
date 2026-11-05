import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import type { DocPreviewExternalLink } from '../../../../../shared/doc-preview-scheme'
import type { DocPreviewGrantOwner } from '../../../../../preload/api/doc-preview-api'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from '@/lib/http-link-routing'

const mocks = vi.hoisted(() => ({ getState: vi.fn(), toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.getState() } }))

import { subscribeDocPreviewExternalLinkConfirmation } from './doc-preview-external-link-confirmation'

const openUrl = vi.fn()
const openBrowser = vi.fn(async () => 'opened-page')
const state = {
  repos: [],
  endpointProjects: [],
  endpointProjectHostSetups: [],
  activeWorktreeId: 'unrelated-workspace',
  settings: { openLinksInApp: true, openLinksInAppModifierInverts: false },
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  unifiedTabsByWorktree: {
    'source-workspace': [
      {
        id: 'source-wrapper',
        entityId: 'browser-1',
        contentType: 'browser' as const,
        groupId: 'source-group'
      }
    ]
  }
}
const runtimeOwner: DocPreviewGrantOwner = {
  kind: 'runtime',
  environmentId: 'source-server',
  worktreeSelector: 'id:source-workspace',
  worktreeRoot: '/repo'
}

function installSubscription(
  confirm: ConfirmationDialogContextValue,
  owner: DocPreviewGrantOwner = runtimeOwner
) {
  let listener: ((payload: DocPreviewExternalLink) => void) | undefined
  const unsubscribe = vi.fn()
  vi.stubGlobal('window', {
    api: {
      shell: { openUrl },
      docPreview: {
        onExternalLink: (callback: (payload: DocPreviewExternalLink) => void) => {
          listener = callback
          return unsubscribe
        }
      }
    }
  })
  const dispose = subscribeDocPreviewExternalLinkConfirmation(confirm, {
    grantId: 'source-grant',
    owner,
    worktreeId: 'source-workspace',
    browserWorkspaceId: 'browser-1'
  })
  return {
    emit: (payload: Partial<DocPreviewExternalLink> = {}) =>
      listener?.({
        url: 'https://example.com/docs?source=preview',
        grantId: 'source-grant',
        ...payload
      }),
    dispose,
    unsubscribe
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  openUrl.mockResolvedValue(undefined)
  openBrowser.mockResolvedValue('opened-page')
  state.settings = { openLinksInApp: true, openLinksInAppModifierInverts: false }
  mocks.getState.mockReturnValue(state)
  registerHttpLinkStoreAccessor(() => state)
  registerWorkspaceHttpLinkBrowserOpener(openBrowser)
  vi.stubGlobal('navigator', { userAgent: 'Mac' })
})
afterEach(() => {
  registerWorkspaceHttpLinkBrowserOpener(null)
  vi.unstubAllGlobals()
})

describe('document preview external-link confirmation', () => {
  it('confirms the exact URL and captures its source before awaiting the answer', async () => {
    let answer: ((confirmed: boolean) => void) | undefined
    const confirm = vi.fn<ConfirmationDialogContextValue>(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const { emit } = installSubscription(confirm)
    emit()
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Open link to example.com?',
        description: 'https://example.com/docs?source=preview'
      })
    )
    expect(openBrowser).not.toHaveBeenCalled()
    state.unifiedTabsByWorktree['source-workspace'][0].groupId = 'moved-group'
    answer?.(true)
    await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledOnce())
    expect(openBrowser).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'source-workspace',
        expectedRuntimeEnvironmentId: 'source-server',
        allowClientBrowserFallback: true,
        linkContext: expect.objectContaining({
          linkIntent: expect.objectContaining({
            sourceTabId: 'source-wrapper',
            initialGroupId: 'source-group'
          })
        })
      })
    )
    state.unifiedTabsByWorktree['source-workspace'][0].groupId = 'source-group'
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('opens nothing when the reader cancels or the preview is disposed while confirming', async () => {
    const cancelled = installSubscription(
      vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(false)
    )
    cancelled.emit()
    const disposed = installSubscription(
      vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)
    )
    disposed.emit()
    disposed.dispose()
    await Promise.resolve()
    expect(disposed.unsubscribe).toHaveBeenCalledOnce()
    expect(openBrowser).not.toHaveBeenCalled()
    expect(openUrl).not.toHaveBeenCalled()
  })
})
