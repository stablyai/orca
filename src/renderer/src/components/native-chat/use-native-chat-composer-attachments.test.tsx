// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderProbe } from './native-chat-composer-attachments-test-probe'
import {
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache
} from './use-native-chat-composer-attachments'

import { readNativeChatDraftCache } from './native-chat-draft-cache'

import type * as RemoteRuntimePtyIdModule from '../../../../shared/remote-runtime/remote-runtime-pty-id'

import { useAppStore } from '@/store'
import { resolveNativeChatDraftOwner } from '@/lib/native-chat-draft-owner'
import type { Tab } from '../../../../shared/tab-types'

const initialStoreState = useAppStore.getInitialState()
function publishOwner(
  scopeKey: string,
  owner: draftStorage.NativeChatComposerDraftOwner | undefined
): void {
  const sessionId = draftStore.structuredAgentSessionIdOfDraftScope(scopeKey)
  const tab: Tab = {
    id: scopeKey,
    entityId: sessionId ?? scopeKey,
    worktreeId: owner?.workspaceId ?? 'unknown',
    groupId: 'group',
    contentType: 'agent-session',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  useAppStore.setState({
    unifiedTabsByWorktree: owner ? { [owner.workspaceId]: [tab] } : {},
    activeWorktreeId: owner?.workspaceId ?? null,
    activeWorkspaceExecutionHostId: owner?.executionHostId ?? null
  })
}

import * as draftStore from './native-chat-composer-draft-store'
import * as draftStorage from './native-chat-composer-draft-storage'
import { nativeChatImagesHoldSend } from './native-chat-image-reattach'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
const runtimeTarget = vi.hoisted(() => ({ remote: false }))
vi.mock('../../../../shared/remote-runtime/remote-runtime-pty-id', async (importOriginal) => ({
  ...(await importOriginal<typeof RemoteRuntimePtyIdModule>()),
  isRemoteRuntimePtyId: () => runtimeTarget.remote
}))

function publishUnrelatedStatuses(): void {
  for (let tick = 1; tick <= 24; tick += 1) {
    useAppStore.setState((state) => ({
      runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId).set('other-host', {
        status: null,
        checkedAt: tick
      })
    }))
    useAppStore.setState((state) => ({
      agentStatusByPaneKey: {
        ...state.agentStatusByPaneKey,
        'other-tab:other-pane': {
          paneKey: 'other-tab:other-pane',
          state: 'working',
          prompt: 'background work',
          updatedAt: tick,
          stateStartedAt: 1,
          stateHistory: []
        }
      }
    }))
  }
}

describe('useNativeChatComposerAttachments', () => {
  afterEach(() => {
    useAppStore.setState(initialStoreState, true)
    runtimeTarget.remote = false
    clearNativeChatAttachmentCacheForTests()
    document.body.replaceChildren()
  })

  it('ignores a late missing-file result from a previous host and retries when local again', async () => {
    const scope = 'agent-session:host-changed'
    const image = { id: 'old', path: '/state/agent-session-attachments/upload/shot.png' }
    const storedOwner: draftStorage.NativeChatComposerDraftOwner = {
      workspaceId: 'folder-workspace',
      executionHostId: 'local'
    }
    const storage = draftStorage.createMemoryNativeChatComposerDraftStorage()
    storage.drafts.set(scope, { text: '', images: [image], owner: storedOwner, savedAt: 1 })
    draftStorage.setNativeChatComposerDraftStorageForTests(storage)
    publishOwner(scope, storedOwner)
    const resolveOwner = vi.fn((key: string) =>
      resolveNativeChatDraftOwner(useAppStore.getState(), key)
    )
    draftStore.setNativeChatComposerDraftOwnerResolver(resolveOwner)
    const old = Promise.withResolvers<boolean>()
    const next = Promise.withResolvers<boolean>()
    const pathExists = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise)
    const originalApi = window.api
    Object.assign(window, { api: { fs: { pathExists } } })
    let probe: Awaited<ReturnType<typeof renderProbe>> | undefined
    const originalState = useAppStore.getState()
    try {
      await draftStore.hydrateNativeChatComposerDrafts()
      probe = await renderProbe(scope, true)
      expect(nativeChatImagesHoldSend(probe.latest().imageAttachments)).toBe(true)
      expect(pathExists).toHaveBeenCalledTimes(1)
      publishOwner(scope, { ...storedOwner, executionHostId: 'runtime:remote' })
      await act(async () => old.resolve(false))
      expect(draftStore.readNativeChatComposerDraft(scope).images).toEqual([image])
      await act(async () => useAppStore.setState({}))
      expect(nativeChatImagesHoldSend(probe.latest().imageAttachments)).toBe(false)
      publishOwner(scope, storedOwner)
      await act(async () => useAppStore.setState({}))
      expect(pathExists).toHaveBeenCalledTimes(2)
      expect(nativeChatImagesHoldSend(probe.latest().imageAttachments)).toBe(true)
      await act(async () => next.resolve(false))
      expect(probe.latest().imageAttachments).toMatchObject([
        { id: image.id, path: '', unavailableName: 'shot.png' }
      ])
      expect(draftStore.readNativeChatComposerDraft(scope).owner).toEqual(storedOwner)
      resolveOwner.mockClear()
      act(publishUnrelatedStatuses)
      expect(resolveOwner).not.toHaveBeenCalled()
    } finally {
      act(() => probe?.root.unmount())
      useAppStore.setState({
        runtimeStatusByEnvironmentId: originalState.runtimeStatusByEnvironmentId,
        agentStatusByPaneKey: originalState.agentStatusByPaneKey
      })
      Object.assign(window, { api: originalApi })
    }
  })

  it('checks a restored store image when its owner becomes local, holding Send and preserving a newer edit', async () => {
    const scope = 'agent-session:restored'
    const image = { id: 'old', path: '/state/agent-session-attachments/upload/shot.png' }
    const storage = draftStorage.createMemoryNativeChatComposerDraftStorage()
    storage.drafts.set(scope, { text: '', images: [image, { ...image, id: 'edit' }], savedAt: 1 })
    const paste = { id: 'paste', path: '/state/native-chat-pastes/orca-paste-1-a.png' }
    storage.drafts.set('pty-1', { text: '', images: [image, paste], savedAt: 1 })
    draftStorage.setNativeChatComposerDraftStorageForTests(storage)
    publishOwner(scope, undefined)
    draftStore.setNativeChatComposerDraftOwnerResolver((key) =>
      resolveNativeChatDraftOwner(useAppStore.getState(), key)
    )
    const exists = Promise.withResolvers<boolean>()
    const pathExists = vi.fn(() => exists.promise)
    const originalApi = window.api
    Object.assign(window, {
      api: {
        fs: { pathExists },
        ui: {
          restoreNativeChatPastes: async () => [{ path: paste.path, kept: true, exists: true }]
        }
      }
    })
    try {
      await draftStore.hydrateNativeChatComposerDrafts()
      const terminal = await renderProbe('pty-1')
      act(() => terminal.latest().attachResolvedPaths(['/repo/fresh.png']))
      expect(nativeChatImagesHoldSend(terminal.latest().imageAttachments)).toBe(false)
      act(() => terminal.root.unmount())
      const probe = await renderProbe(scope, true)
      publishOwner(scope, { workspaceId: 'wt', executionHostId: 'runtime:remote' })
      act(() => useAppStore.setState({}))
      expect(pathExists).not.toHaveBeenCalled()
      publishOwner(scope, { workspaceId: 'wt', executionHostId: 'local' })
      act(() => useAppStore.setState({}))
      expect(nativeChatImagesHoldSend(probe.latest().imageAttachments)).toBe(true)
      publishOwner(scope, { workspaceId: 'wt', executionHostId: 'runtime:remote' })
      await act(async () => useAppStore.setState({}))
      expect(nativeChatImagesHoldSend(probe.latest().imageAttachments)).toBe(false)
      publishOwner(scope, { workspaceId: 'wt', executionHostId: 'local' })
      act(() => useAppStore.setState({}))
      const newer = { id: 'edit', path: '/repo/new.png' }
      await act(async () => {
        draftStore.updateNativeChatComposerDraft(scope, { images: [image, newer] }, 'immediate')
        exists.resolve(false)
      })
      expect(probe.latest().imageAttachments).toMatchObject([
        { id: 'old', path: '', unavailableName: 'shot.png' },
        newer
      ])
      act(() => probe.root.unmount())
    } finally {
      Object.assign(window, { api: originalApi })
    }
  })

  it('clears a pending image on disable without putting its marker in prompt text', async () => {
    const probe = await renderProbe('structured-1', true)
    act(() => {
      probe.latest().beginPendingImageAttachment()
    })
    expect(probe.latest().imageAttachments).toMatchObject([{ pending: true }])
    expect(readNativeChatDraftCache('structured-1')).toBe('')

    await probe.rerender('structured-1', true)
    expect(probe.latest().imageAttachments).toEqual([])
    expect(readNativeChatDraftCache('structured-1')).toBe('')
    act(() => probe.root.unmount())
  })

  it('keeps an upload that finishes while the composer is unmounted, for when it returns', async () => {
    const probe = await renderProbe('pty-gone')
    const chips = probe.latest().pendingChips
    const begun: { image?: string | null; removed?: string | null; reference?: string | null } = {}
    act(() => {
      begun.image = chips.begin(undefined, 'shot.png')
      begun.removed = chips.begin(undefined, 'old.png')
      begun.reference = chips.begin(undefined, 'notes.pdf')
    })
    const { image, removed, reference } = begun
    if (!image || !removed || !reference) {
      throw new Error('expected pending chips')
    }
    act(() => probe.latest().removeImageAttachment(removed))
    // A prompt card took the composer's place while the files uploaded.
    act(() => probe.root.unmount())

    chips.resolve(image, '/srv/agent-session-attachments/u1/shot.png')
    chips.resolve(removed, '/srv/agent-session-attachments/u2/old.png')
    chips.attachReferences([{ id: reference, path: '/srv/agent-session-attachments/u3/notes.pdf' }])

    expect(readNativeChatAttachmentCache('pty-gone')).toEqual([
      { id: image, path: '/srv/agent-session-attachments/u1/shot.png' }
    ])
    expect(readNativeChatDraftCache('pty-gone')).toBe(
      '@/srv/agent-session-attachments/u3/notes.pdf'
    )
    const back = await renderProbe('pty-gone')
    expect(back.latest().imageAttachments).toMatchObject([
      { path: '/srv/agent-session-attachments/u1/shot.png' }
    ])
    act(() => back.root.unmount())
  })
})
