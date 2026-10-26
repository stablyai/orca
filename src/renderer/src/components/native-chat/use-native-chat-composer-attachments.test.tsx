// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderProbe } from './native-chat-composer-attachments-test-probe'
import {
  appendNativeChatAttachmentCache,
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache
} from './use-native-chat-composer-attachments'
import * as draftCache from './native-chat-draft-cache'
import { nativeChatPendingAttachmentSnapshot } from './native-chat-pending-attachment-cache'
import { readNativeChatDraftCache } from './native-chat-draft-cache'
import { NATIVE_FILE_DROP_MAX_PATHS } from '../../../../shared/native-file-drop'
import { imageReferenceToken } from '../../../../shared/native-chat-image-reference'
import type * as RemoteRuntimePtyIdModule from '../../../../shared/remote-runtime-pty-id'

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
import { recheckNativeChatComposerDraftImagesIn } from './native-chat-composer-draft-image-check'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
const runtimeTarget = vi.hoisted(() => ({ remote: false }))
vi.mock('../../../../shared/remote-runtime-pty-id', async (importOriginal) => ({
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

  it('reexports the attachment cache functions from the draft store view', () => {
    expect(readNativeChatAttachmentCache).toBe(draftCache.readNativeChatAttachmentCache)
    expect(appendNativeChatAttachmentCache).toBe(draftCache.appendNativeChatAttachmentCache)
    expect(clearNativeChatAttachmentCacheForTests).toBe(
      draftCache.clearNativeChatAttachmentCacheForTests
    )
  })

  it.each<{
    name: string
    scope: string
    images: draftStorage.NativeChatComposerDraftImage[]
    check: 'none' | 'path' | 'paste'
  }>([
    { name: 'empty checks', scope: 'agent-session:empty', images: [], check: 'none' },
    {
      name: 'ordinary paths',
      scope: 'agent-session:path',
      images: [{ id: 'path', path: '/repo/shot.png' }],
      check: 'path'
    },
    {
      name: 'kept local pastes',
      scope: 'agent-session:paste',
      images: [{ id: 'paste', path: '/state/native-chat-pastes/orca-paste-1-a.png' }],
      check: 'paste'
    },
    {
      name: 'SSH attachment-store paths',
      scope: 'agent-session:ssh',
      images: [
        {
          id: 'ssh',
          path: '/state/agent-session-attachments/upload/shot.png',
          connectionId: 'ssh-host'
        }
      ],
      check: 'none'
    },
    {
      name: 'ineligible terminal scopes',
      scope: 'tab:leaf',
      images: [{ id: 'terminal', path: '/state/agent-session-attachments/upload/shot.png' }],
      check: 'none'
    }
  ])(
    'does no ownership resolution for $name across status publications',
    async ({ scope, images, check }) => {
      const storage = draftStorage.createMemoryNativeChatComposerDraftStorage()
      const owner: draftStorage.NativeChatComposerDraftOwner = {
        workspaceId: 'folder-workspace',
        executionHostId: 'local'
      }
      storage.drafts.set(scope, { text: '', images, owner, savedAt: 1 })
      draftStorage.setNativeChatComposerDraftStorageForTests(storage)
      const resolveOwner = vi.fn(() => owner)
      draftStore.setNativeChatComposerDraftOwnerResolver(resolveOwner)
      const validation = Promise.withResolvers<boolean>()
      const pathExists = vi.fn(() => validation.promise)
      const restoreNativeChatPastes = vi.fn(async () => {
        const exists = await validation.promise
        return images.map(({ path }) => ({ path, kept: true, exists }))
      })
      const originalApi = window.api
      const originalState = useAppStore.getState()
      let probe: Awaited<ReturnType<typeof renderProbe>> | undefined
      Object.assign(window, { api: { fs: { pathExists }, ui: { restoreNativeChatPastes } } })
      try {
        await draftStore.hydrateNativeChatComposerDrafts()
        probe = await renderProbe(scope, true)
        expect(pathExists).toHaveBeenCalledTimes(check === 'path' ? 1 : 0)
        expect(restoreNativeChatPastes).toHaveBeenCalledTimes(check === 'paste' ? 1 : 0)
        const callsAtMount = resolveOwner.mock.calls.length
        act(publishUnrelatedStatuses)
        expect(resolveOwner.mock.calls.length - callsAtMount).toBe(0)
        expect(resolveOwner).not.toHaveBeenCalled()
        await act(async () => validation.resolve(false))
        expect(probe.latest().imageAttachments).toMatchObject(
          check === 'none'
            ? images
            : [{ id: images[0].id, path: '', unavailableName: expect.any(String) }]
        )
        act(publishUnrelatedStatuses)
        expect(resolveOwner).not.toHaveBeenCalled()
        expect(pathExists).toHaveBeenCalledTimes(check === 'path' ? 1 : 0)
        expect(restoreNativeChatPastes).toHaveBeenCalledTimes(check === 'paste' ? 1 : 0)
      } finally {
        act(() => probe?.root.unmount())
        useAppStore.setState({
          runtimeStatusByEnvironmentId: originalState.runtimeStatusByEnvironmentId,
          agentStatusByPaneKey: originalState.agentStatusByPaneKey
        })
        Object.assign(window, { api: originalApi })
      }
    }
  )

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

  it.each([true, false])(
    'rechecks a removed upload after restore settles (composer mounted: %s)',
    async (mounted) => {
      const scope = 'agent-session:swept-later'
      const image = { id: 'old', path: '/state/agent-session-attachments/upload/shot.png' }
      const other = { id: 'other', path: '/state/agent-session-attachments/upload-2/b.png' }
      const storage = draftStorage.createMemoryNativeChatComposerDraftStorage()
      storage.drafts.set(scope, { text: 'hi', images: [image, other], savedAt: 1 })
      draftStorage.setNativeChatComposerDraftStorageForTests(storage)
      publishOwner(scope, { workspaceId: 'wt', executionHostId: 'local' })
      draftStore.setNativeChatComposerDraftOwnerResolver((key) =>
        resolveNativeChatDraftOwner(useAppStore.getState(), key)
      )
      let present = true
      const pathExists = vi.fn(async () => present)
      const originalApi = window.api
      Object.assign(window, { api: { fs: { pathExists }, ui: {} } })
      try {
        await draftStore.hydrateNativeChatComposerDrafts()
        const probe = await renderProbe(scope, true)
        await act(async () => {})
        expect(nativeChatImagesHoldSend(probe.latest().imageAttachments)).toBe(false)
        if (!mounted) {
          act(() => probe.root.unmount())
        }
        present = false
        await act(async () =>
          recheckNativeChatComposerDraftImagesIn('/state/agent-session-attachments/upload')
        )
        expect(draftStore.readNativeChatComposerDraft(scope).images).toMatchObject([
          { id: 'old', path: '', unavailableName: 'shot.png' },
          other
        ])
        if (mounted) {
          expect(probe.latest().imageAttachments).toMatchObject([
            { id: 'old', path: '', unavailableName: 'shot.png' },
            other
          ])
          act(() => probe.root.unmount())
        }
        const reopened = await renderProbe(scope, true)
        expect(nativeChatImagesHoldSend(reopened.latest().imageAttachments)).toBe(true)
        act(() => reopened.root.unmount())
      } finally {
        Object.assign(window, { api: originalApi })
      }
    }
  )

  it('holds attached images as chips (deferred to submit) and restores them on remount', async () => {
    const first = await renderProbe('pty-1')

    await act(async () => {
      first.latest().attachResolvedPaths(['/tmp/orca-native-chat-attach-test.png'])
    })

    // Attach only on submit so chip removal cannot leave stale image paths in TUI input.
    expect(first.latest().imageAttachments).toMatchObject([
      { path: '/tmp/orca-native-chat-attach-test.png' }
    ])
    expect(readNativeChatAttachmentCache('pty-1')).toMatchObject([
      { path: '/tmp/orca-native-chat-attach-test.png' }
    ])

    act(() => first.root.unmount())
    const second = await renderProbe('pty-1')

    expect(second.latest().imageAttachments).toMatchObject([
      { path: '/tmp/orca-native-chat-attach-test.png' }
    ])
    act(() => second.root.unmount())
  })

  it.each([false, true])(
    'marks each image in the prompt only in a structured chat (structured=%s)',
    async (structured) => {
      const scope = structured ? 'structured-1' : 'pty-1'
      const probe = await renderProbe(scope, structured)
      await act(async () => probe.latest().attachResolvedPaths(['/tmp/attached.png']))
      act(() => {
        probe.latest().beginPendingImageAttachment()
      })

      const ids = probe.latest().imageAttachments.map(({ id }) => id)
      expect(ids).toHaveLength(2)
      expect(readNativeChatDraftCache(scope)).toBe(
        structured ? ids.map(imageReferenceToken).join('\n\n') : ''
      )
      act(() => probe.root.unmount())
    }
  )

  it('takes the chip of an image still on its way out of the prompt when the composer is disabled', async () => {
    const probe = await renderProbe('structured-1', true)
    act(() => {
      probe.latest().beginPendingImageAttachment()
    })
    expect(readNativeChatDraftCache('structured-1')).not.toBe('')

    await probe.rerender('structured-1', true)
    expect(probe.latest().imageAttachments).toEqual([])
    expect(readNativeChatDraftCache('structured-1')).toBe('')
    act(() => probe.root.unmount())
  })

  it('accepts host-readable image paths without a PTY for structured transport', async () => {
    const probe = await renderProbe('structured-session-1', true)

    await act(async () => {
      probe.latest().attachResolvedPaths(['/tmp/structured-image.png'])
    })

    expect(probe.latest().imageAttachments).toMatchObject([{ path: '/tmp/structured-image.png' }])
    act(() => probe.root.unmount())
  })

  it('accepts only ownership-validated paths for a remote runtime target', async () => {
    runtimeTarget.remote = true
    const probe = await renderProbe('remote-pty')

    act(() => probe.latest().attachResolvedPaths(['/remote/untrusted.txt']))
    expect(probe.draft()).toBe('')
    expect(probe.notice()).toBe('Local attachments are not available for remote sessions.')

    act(() =>
      probe.latest().attachResolvedPaths(['/remote/trusted.txt'], undefined, {
        targetOwnerIsCurrent: () => true
      })
    )
    expect(probe.draft()).toBe('@/remote/trusted.txt ')
    act(() => probe.root.unmount())
  })

  it('rejects an ownership-validated path when its owner changes before IME flush', async () => {
    let composing = true
    let ownerCurrent = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    act(() =>
      probe.latest().attachResolvedPaths(['/remote/trusted.txt'], undefined, {
        targetOwnerIsCurrent: () => ownerCurrent
      })
    )
    ownerCurrent = false
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('')
    expect(probe.notice()).toBe('Files can only be attached to their source workspace.')
    act(() => probe.root.unmount())
  })

  // False ownership must name the ownership failure, even though the current immediate caller checks synchronously.
  it('names the ownership failure when an immediate attach arrives already false', async () => {
    runtimeTarget.remote = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => false })

    act(() =>
      probe.latest().attachResolvedPaths(['/remote/moved.txt'], undefined, {
        targetOwnerIsCurrent: () => false
      })
    )

    expect(probe.draft()).toBe('')
    expect(probe.notice()).toBe('Files can only be attached to their source workspace.')
    act(() => probe.root.unmount())
  })

  it('keeps the owned half of a mixed queued batch after the target becomes remote', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    act(() => {
      probe.latest().attachResolvedPaths(['/remote/trusted.txt'], undefined, {
        targetOwnerIsCurrent: () => true
      })
      probe.latest().attachResolvedPaths(['/local/untrusted.txt'])
    })
    runtimeTarget.remote = true
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('@/remote/trusted.txt ')
    expect(probe.notice()).toBe('Local attachments are not available for remote sessions.')
    act(() => probe.root.unmount())
  })

  // Preserve mixed attachment order; grouping by ownership would move workspace drops ahead of earlier pastes.
  it('keeps a mixed queued batch in the order it was attached', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    act(() => {
      probe.latest().attachResolvedPaths(['/local/first.txt'])
      probe.latest().attachResolvedPaths(['/remote/second.txt'], undefined, {
        targetOwnerIsCurrent: () => true
      })
    })
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('@/local/first.txt @/remote/second.txt ')
    act(() => probe.root.unmount())
  })

  it('refuses a wholly client-local queued batch on a remote target', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    act(() => probe.latest().attachResolvedPaths(['/local/untrusted.txt']))
    runtimeTarget.remote = true
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('')
    expect(probe.notice()).toBe('Local attachments are not available for remote sessions.')
    act(() => probe.root.unmount())
  })

  // Refuse permanently blocked targets before queueing so invalid paths cannot exhaust the pending budget.
  it('refuses an already-blocked target at the drop without spending the queue budget', async () => {
    runtimeTarget.remote = true
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    const refused = Array.from(
      { length: NATIVE_FILE_DROP_MAX_PATHS },
      (_unused, index) => `/local/refused-${index}.txt`
    )
    act(() => probe.latest().attachResolvedPaths(refused))
    expect(probe.notice()).toBe('Local attachments are not available for remote sessions.')

    useAppStore.setState(initialStoreState, true)
    runtimeTarget.remote = false
    act(() => probe.latest().attachResolvedPaths(['/local/allowed.txt']))
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('@/local/allowed.txt ')
    act(() => probe.root.unmount())
  })

  it('removes an attached image chip cleanly', async () => {
    const probe = await renderProbe('pty-1')
    await act(async () => {
      probe.latest().attachResolvedPaths(['/tmp/orca-native-chat-remove-test.png'])
    })
    const id = probe.latest().imageAttachments[0]?.id
    expect(id).toBeDefined()
    await act(async () => {
      probe.latest().removeImageAttachment(id as string)
    })
    expect(probe.latest().imageAttachments).toMatchObject([])
    expect(readNativeChatAttachmentCache('pty-1')).toMatchObject([])
    act(() => probe.root.unmount())
  })

  it('adopts browser text before draining ordered duplicate paths exactly once', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })
    const textarea = probe.textarea()
    textarea.focus()
    textarea.value = '각 '
    textarea.setSelectionRange(2, 2)
    const focus = vi.spyOn(textarea, 'focus')

    act(() => {
      probe.latest().attachResolvedPaths(['/remote/b.txt', '/remote/b.txt'])
      probe.latest().attachResolvedPaths(['/remote/a.txt'])
    })
    expect(probe.draft()).toBe('')

    composing = false
    textarea.blur()
    act(() => {
      probe.latest().adoptDraft(textarea.value)
      probe.latest().flushPendingAttachments()
      probe.latest().flushPendingAttachments()
    })

    expect(probe.draft()).toBe('각 @/remote/b.txt @/remote/b.txt @/remote/a.txt ')
    // Advance a frame so scheduled focus theft cannot make these assertions pass vacuously.
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(textarea)
    act(() => probe.root.unmount())
  })

  it('drops queued paths after any disabled transition', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    act(() => probe.latest().attachResolvedPaths(['/remote/a.txt']))
    await probe.rerender('pty-1', true)
    await probe.rerender('pty-1', false)
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('')
    act(() => probe.root.unmount())
  })

  it('caps paths queued during composition and keeps overflow visible after flush', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })
    const acceptedPaths = Array.from(
      { length: NATIVE_FILE_DROP_MAX_PATHS },
      (_, index) => `/remote/accepted-${index}.txt`
    )

    act(() => {
      probe.latest().attachResolvedPaths(acceptedPaths)
      probe.latest().attachResolvedPaths(['/remote/rejected.txt'])
    })

    expect(probe.draft()).toBe('')
    expect(probe.notice()).toBe(
      'Too many attachments are waiting. Finish composing before attaching more.'
    )

    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft().match(/@\/remote\/accepted-/g)).toHaveLength(NATIVE_FILE_DROP_MAX_PATHS)
    expect(probe.draft()).not.toContain('rejected.txt')
    expect(probe.notice()).toBe(
      'Too many attachments are waiting. Finish composing before attaching more.'
    )
    act(() => probe.root.unmount())
  })

  it('settles a pending image attachment in place', async () => {
    const probe = await renderProbe('pty-1')
    let id: string | null = null
    act(() => {
      id = probe.latest().beginPendingImageAttachment('blob:preview-1')
    })
    expect(id).toBeTruthy()
    expect(probe.latest().imageAttachments).toMatchObject([
      { id, path: '', previewUrl: 'blob:preview-1', pending: true }
    ])

    act(() => {
      probe.latest().resolvePendingImageAttachment(id as string, '/tmp/resolved.png', 'conn-1')
    })

    expect(probe.latest().imageAttachments).toMatchObject([
      { id, path: '/tmp/resolved.png', previewUrl: 'blob:preview-1', connectionId: 'conn-1' }
    ])
    expect(probe.latest().imageAttachments[0]?.pending).toBeUndefined()
    act(() => probe.root.unmount())
  })

  it('drops just the targeted pending chip', async () => {
    const probe = await renderProbe('pty-1')
    let firstId: string | null = null
    let secondId: string | null = null
    act(() => {
      firstId = probe.latest().beginPendingImageAttachment('blob:preview-1')
    })
    act(() => {
      secondId = probe.latest().beginPendingImageAttachment('blob:preview-2')
    })

    act(() => {
      probe.latest().dropPendingImageAttachment(firstId as string)
    })

    expect(probe.latest().imageAttachments).toMatchObject([
      { id: secondId, previewUrl: 'blob:preview-2', pending: true }
    ])
    act(() => probe.root.unmount())
  })

  it('tells a finishing upload that the user removed its chip', async () => {
    const probe = await renderProbe('pty-1')
    const begun: { removed?: string | null; kept?: string | null } = {}
    act(() => {
      begun.removed = probe.latest().pendingChips.begin(undefined, 'report.pdf')
      begun.kept = probe.latest().pendingChips.begin(undefined, 'notes.md')
    })
    const { removed, kept } = begun
    if (!removed || !kept) {
      throw new Error('expected pending chips')
    }
    act(() => probe.latest().removeImageAttachment(removed))

    const live: boolean[] = []
    act(() => {
      live.push(probe.latest().pendingChips.drop(removed), probe.latest().pendingChips.drop(kept))
    })
    expect(live).toEqual([false, true])
    expect(probe.latest().imageAttachments).toEqual([])
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

  it('shows a dropped file still uploading as pending to a composer that comes back, then settles it there', async () => {
    const first = await renderProbe('pty-drop')
    const chips = first.latest().pendingChips
    let chipId: string | null = null
    act(() => {
      chipId = chips.begin(undefined, 'shot.png')
    })
    if (!chipId) {
      throw new Error('expected a pending chip')
    }
    const id: string = chipId
    act(() => first.root.unmount())

    const back = await renderProbe('pty-drop')
    expect(back.latest().imageAttachments).toMatchObject([
      { id, pending: true, pendingName: 'shot.png' }
    ])
    act(() => chips.resolve(id, '/srv/agent-session-attachments/u5/shot.png'))
    expect(back.latest().imageAttachments).toEqual([
      { id, path: '/srv/agent-session-attachments/u5/shot.png' }
    ])
    act(() => back.root.unmount())
  })

  it('gives uploads unique IDs across composers remounted in the same clock tick', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      const first = await renderProbe('pty-ids', true)
      const ids: (string | null)[] = []
      act(() => ids.push(first.latest().pendingChips.begin(undefined, 'first.pdf')))
      act(() => first.root.unmount())
      const next = await renderProbe('pty-ids', true)
      act(() => ids.push(next.latest().pendingChips.begin(undefined, 'second.pdf')))
      expect(new Set(ids).size).toBe(2)
      expect(nativeChatPendingAttachmentSnapshot('pty-ids')).toHaveLength(2)
      act(() => next.root.unmount())
    } finally {
      now.mockRestore()
    }
  })

  it('inserts a stored file at the caret while the composer is showing and not composing', async () => {
    const probe = await renderProbe('pty-caret', true)
    act(() => {
      const chips = probe.latest().pendingChips
      const id = chips.begin(undefined, 'a.pdf')
      if (!id) {
        throw new Error('expected pending chip')
      }
      chips.attachReferences([{ id, path: '/srv/agent-session-attachments/u6/a.pdf' }])
    })
    expect(probe.draft()).toBe('@/srv/agent-session-attachments/u6/a.pdf ')
    expect(readNativeChatDraftCache('pty-caret')).toBe('')
    act(() => probe.root.unmount())
  })

  it('keeps a stored file whose reference is held for an input-method composition across a remount', async () => {
    let composing = true
    const probe = await renderProbe('pty-ime', true, { isComposing: () => composing })
    const chips = probe.latest().pendingChips
    let chipId: string | null = null
    act(() => {
      chipId = chips.begin(undefined, 'notes.pdf')
    })
    if (!chipId) {
      throw new Error('expected a pending chip')
    }
    const id: string = chipId
    // The upload finishes mid-composition: the reference waits for the composition to settle.
    act(() => {
      chips.attachReferences([{ id, path: '/srv/agent-session-attachments/u4/notes.pdf' }])
    })
    // A prompt card takes the composer's place before the composition settles.
    act(() => probe.root.unmount())
    composing = false

    expect(readNativeChatDraftCache('pty-ime')).toContain(
      '@/srv/agent-session-attachments/u4/notes.pdf'
    )
  })

  it('keeps a pending chip in the pending cache, without its preview, and an image attached after it behind it', async () => {
    const probe = await renderProbe('pty-1')
    let pendingId: string | null = null
    act(() => {
      pendingId = probe.latest().beginPendingImageAttachment('blob:preview-1')
    })
    await act(async () => {
      probe.latest().attachResolvedPaths(['/tmp/later.png'])
    })

    // Pending chips survive remounts in memory while later completed images persist without overtaking them.
    expect(nativeChatPendingAttachmentSnapshot('pty-1')).toMatchObject([
      { id: pendingId, path: '', pending: true },
      { path: '/tmp/later.png' }
    ])
    expect(readNativeChatAttachmentCache('pty-1')).toMatchObject([{ path: '/tmp/later.png' }])
    expect(probe.latest().imageAttachments).toMatchObject([
      { id: pendingId, pending: true },
      { path: '/tmp/later.png' }
    ])
    expect(
      probe.latest().imageAttachments.find((attachment) => attachment.id === pendingId)?.previewUrl
    ).toBe('blob:preview-1')

    act(() => probe.latest().resolvePendingImageAttachment(pendingId ?? '', '/tmp/first.png'))
    expect(readNativeChatAttachmentCache('pty-1')).toMatchObject([
      { path: '/tmp/first.png' },
      { path: '/tmp/later.png' }
    ])
    act(() => probe.root.unmount())
  })

  it('removes a finished image from the saved draft while one attached before it is still on its way', async () => {
    const probe = await renderProbe('pty-1')
    let firstId: string | null = null
    let secondId: string | null = null
    act(() => {
      firstId = probe.latest().beginPendingImageAttachment()
      secondId = probe.latest().beginPendingImageAttachment()
    })
    act(() => probe.latest().resolvePendingImageAttachment(secondId ?? '', '/tmp/second.png'))
    act(() => probe.latest().removeImageAttachment(secondId ?? ''))

    expect(readNativeChatAttachmentCache('pty-1')).toEqual([])
    act(() => probe.latest().resolvePendingImageAttachment(firstId ?? '', '/tmp/first.png'))
    expect(readNativeChatAttachmentCache('pty-1')).toMatchObject([{ path: '/tmp/first.png' }])
    expect(probe.latest().imageAttachments).toMatchObject([{ path: '/tmp/first.png' }])
    act(() => probe.root.unmount())
  })

  it('revokes a blob: preview URL on removal but not a data: preview URL', async () => {
    const probe = await renderProbe('pty-1')
    const revoke = vi.spyOn(URL, 'revokeObjectURL')
    let blobId: string | null = null
    act(() => {
      blobId = probe.latest().beginPendingImageAttachment('blob:preview-1')
    })
    act(() => {
      probe.latest().beginPendingImageAttachment('data:image/png;base64,AAAA')
    })

    act(() => {
      probe.latest().dropPendingImageAttachment(blobId as string)
    })
    expect(revoke).toHaveBeenCalledWith('blob:preview-1')

    // Only the remaining data: chip is left to clear; revoke must not fire again.
    revoke.mockClear()
    act(() => {
      probe.latest().clearImageAttachments()
    })
    expect(revoke).not.toHaveBeenCalled()
    act(() => probe.root.unmount())
  })
})
