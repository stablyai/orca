import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcRenderer } from 'electron'
import { docPreviewApi } from '../../../../../preload/api/doc-preview-bridge'
import { DOC_PREVIEW_EXTERNAL_LINK_CHANNEL } from '../../../../../shared/doc-preview-scheme'
import type { ConfirmationDialogContextValue } from '@/components/confirmation-dialog-context'
import type { DocPreviewExternalLink } from '../../../../../shared/doc-preview-scheme'
import type { DocPreviewGrantOwner } from '../../../../../preload/api/doc-preview-api'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener
} from '@/lib/http-link-routing'

const mocks = vi.hoisted(() => ({ getState: vi.fn(), toastError: vi.fn() }))
vi.mock('electron', async () => ({ ipcRenderer: new (await import('node:events')).EventEmitter() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.getState() } }))

import { subscribeDocPreviewExternalLinkConfirmation } from './doc-preview-external-link-confirmation'

const openUrl = vi.fn()
const openBrowser = vi.fn(async () => 'opened-page')
const state = {
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
  it.each([10, 100])(
    'bounds delivery to one equality check per preview at %s listeners',
    async (count) => {
      vi.stubGlobal('window', { api: { shell: { openUrl }, docPreview: docPreviewApi } })
      const confirm = vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)
      const baseline = ipcRenderer.listenerCount(DOC_PREVIEW_EXTERNAL_LINK_CHANNEL)
      const disposers = Array.from({ length: count }, (_, index) =>
        subscribeDocPreviewExternalLinkConfirmation(confirm, {
          grantId: `grant-${index}`,
          owner: runtimeOwner,
          worktreeId: 'source-workspace',
          browserWorkspaceId: 'browser-1'
        })
      )
      let comparisons = 0
      const payload = {
        url: 'https://example.com/',
        get grantId() {
          comparisons += 1
          return 'grant-0'
        }
      }
      mocks.getState.mockClear()
      ipcRenderer.emit(DOC_PREVIEW_EXTERNAL_LINK_CHANNEL, {}, payload)
      await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledOnce())
      expect(comparisons).toBe(count)
      expect(confirm).toHaveBeenCalledOnce()
      expect(mocks.getState).toHaveBeenCalledOnce()
      expect(ipcRenderer.listenerCount(DOC_PREVIEW_EXTERNAL_LINK_CHANNEL)).toBe(baseline + count)
      disposers.forEach((dispose) => dispose())
      expect(ipcRenderer.listenerCount(DOC_PREVIEW_EXTERNAL_LINK_CHANNEL)).toBe(baseline)
      ipcRenderer.emit(DOC_PREVIEW_EXTERNAL_LINK_CHANNEL, {}, payload)
      expect(comparisons).toBe(count)
    }
  )
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

  it.each([
    ['Mac', false, false, false, false, false, true],
    ['Mac', true, false, true, false, true, true],
    ['Windows', true, false, false, true, true, true],
    ['Linux', false, true, false, true, true, false],
    ['Mac', true, false, true, false, false, false],
    ['Mac', true, false, false, false, true, false]
  ] as const)(
    'uses shared destination routing on %s (preference %s, inversion %s, meta %s, ctrl %s, shift %s)',
    async (platform, inApp, inverts, metaKey, ctrlKey, shiftKey, system) => {
      vi.stubGlobal('navigator', { userAgent: platform })
      state.settings = { openLinksInApp: inApp, openLinksInAppModifierInverts: inverts }
      const { emit } = installSubscription(
        vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)
      )
      emit({ modifiers: { metaKey, ctrlKey, shiftKey } })
      await vi.waitFor(() => expect(system ? openUrl : openBrowser).toHaveBeenCalledOnce())
      expect(system ? openBrowser : openUrl).not.toHaveBeenCalled()
    }
  )

  it('keeps a direct SSH preview on its captured connection', async () => {
    const { emit } = installSubscription(
      vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true),
      { kind: 'ssh', connectionId: 'ssh-source' }
    )
    emit()
    await vi.waitFor(() =>
      expect(openBrowser).toHaveBeenCalledWith(
        expect.objectContaining({ expectedSshConnectionId: 'ssh-source' })
      )
    )
  })

  it('ignores other previews and events queued from a replaced grant', () => {
    const confirm = vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)
    const { emit } = installSubscription(confirm)
    emit({ grantId: 'other-preview' })
    emit({ grantId: 'retired-grant' })
    expect(confirm).not.toHaveBeenCalled()
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

  it('uses the shared failure surface once when the chosen browser rejects the open', async () => {
    openBrowser.mockRejectedValue(new Error('Unable to open URL.'))
    const { emit } = installSubscription(
      vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)
    )
    emit()
    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith('Unable to open URL.')
    )
  })

  it('reports a rejected system open once without exposing OS errors or retrying', async () => {
    state.settings.openLinksInApp = false
    openUrl.mockRejectedValue(new Error('private OS provider details'))
    const { emit } = installSubscription(
      vi.fn<ConfirmationDialogContextValue>().mockResolvedValue(true)
    )
    emit()
    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith('Unable to open URL.')
    )
    expect(openUrl).toHaveBeenCalledOnce()
    expect(openBrowser).not.toHaveBeenCalled()
  })
})
