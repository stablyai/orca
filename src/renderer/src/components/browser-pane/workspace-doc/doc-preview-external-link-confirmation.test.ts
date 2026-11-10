import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import type { DocPreviewExternalLink } from '../../../../../shared/document-preview/doc-preview-scheme'
import type { DocPreviewGrantOwner } from '../../../../../preload/api/doc-preview-api'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from '@/lib/browser/navigation/http-link-routing'

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
