// @vitest-environment happy-dom
import {
  mocks,
  launchIntent,
  sends,
  composerDraft
} from './structured-agent-session-launch.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { moveStructuredAgentLaunchDraft } from './agent-session/launch/structured-agent-session-launch-draft'
import { nativeChatDraftPositions } from '@/components/native-chat/native-chat-composer-draft-memory'
import { startStructuredAgentLaunch } from './agent-session/launch/structured-agent-session-launch'
import { hasStagedStructuredLaunchPrompt } from './agent-session/launch/structured-agent-session-launch-prompt'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  flushNativeChatComposerDrafts,
  isNativeChatComposerDraftUnsaved,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import { resetStructuredAgentLaunchRegistryForTests } from './agent-session/launch/structured-agent-session-launch-registry'
import { act, renderHook } from '@testing-library/react'
import { useNativeChatDraft } from '@/components/native-chat/use-native-chat-draft'
import { useNativeChatStructuredComposerSend } from '@/components/native-chat/use-native-chat-structured-composer-send'

describe('structured launch draft persistence', () => {
  it.each(['claude', 'codex'] as const)(
    'restores an unmounted %s hand-off, then keeps Send/clear empty',
    async (agent) => {
      const storage = createMemoryNativeChatComposerDraftStorage()
      setNativeChatComposerDraftStorageForTests(storage)
      const intent = {
        ...launchIntent('folder-draft', 'draft-session'),
        agent,
        executionHostId: 'ssh:remote' as const
      }
      mocks.createIntent.mockReturnValueOnce(intent)
      mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
      const text = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n')
      const launch = startStructuredAgentLaunch(intent.worktreeId, agent, {
        requestId: 'request-1',
        prompt: text,
        promptDelivery: 'draft'
      })
      const scope = structuredAgentSessionDraftScopeKey(launch.sessionId)
      expect(readNativeChatComposerDraft(scope)).toMatchObject({
        text,
        owner: { workspaceId: 'folder-draft', executionHostId: 'ssh:remote' }
      })
      await launch.launchResult
      expect(hasStagedStructuredLaunchPrompt(launch.sessionId)).toBe(false)
      expect(launch.promptDeliveryResult).toBeUndefined()
      expect(sends()).toHaveLength(0)
      await nativeChatComposerDraftWritesSettled()
      expect(storage.drafts.get(scope)?.text).toBe(text)
      const restart = async () => {
        clearNativeChatComposerDraftsForTests()
        resetStructuredAgentLaunchRegistryForTests()
        setNativeChatComposerDraftStorageForTests(storage)
        await hydrateNativeChatComposerDrafts()
      }
      await restart()
      expect(composerDraft(launch.sessionId)).toBe(text)
      const send = vi.fn(() => true)
      const composer = renderHook(() => {
        const draft = useNativeChatDraft(scope, () => false)
        return useNativeChatStructuredComposerSend({
          agent,
          draftScopeKey: scope,
          imageAttachments: [],
          isComposing: () => false,
          setDraft: draft.setDraft,
          setCaret: vi.fn(),
          clearSkillOrigin: vi.fn(),
          structuredTransport: {
            sessionId: launch.sessionId,
            runtime: 'remote',
            runtimeEnvironmentId: 'remote',
            capturePresentation: () => () => true,
            send,
            onError: vi.fn(),
            optionSnapshot: [],
            dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
            optionsSurface: {
              getSnapshot: () => [],
              setOption: vi.fn(),
              invokeAction: vi.fn(),
              subscribe: () => () => {}
            }
          }
        })
      })
      await act(() => composer.result.current(text))
      expect(send).toHaveBeenCalledExactlyOnceWith(text, [])
      composer.unmount()
      await nativeChatComposerDraftWritesSettled()
      await restart()
      expect(composerDraft(launch.sessionId)).toBe('')
      updateNativeChatComposerDraft(scope, { text }, 'immediate')
      updateNativeChatComposerDraft(scope, { text: '', document: undefined }, 'immediate')
      await nativeChatComposerDraftWritesSettled()
      await restart()
      expect(composerDraft(launch.sessionId)).toBe('')
    }
  )

  it('moves a draft written before the chat existed into the new chat', async () => {
    setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
    const intent = launchIntent('created-worktree', 'moved-draft-session')
    mocks.createIntent.mockReturnValueOnce(intent)
    mocks.launch.mockResolvedValue({ sessionId: intent.sessionId, fence: 1 })
    updateNativeChatComposerDraft('pending-chat', { text: 'and add a test' }, 'immediate')

    const launch = startStructuredAgentLaunch(intent.worktreeId, 'claude', {
      requestId: 'request-2',
      prompt: 'fix the bug',
      promptDelivery: 'auto-submit',
      draftFromScope: 'pending-chat'
    })
    await launch.launchResult

    expect(composerDraft(launch.sessionId)).toBe('and add a test')
    expect(readNativeChatComposerDraft('pending-chat').text).toBe('')
  })
})

describe('launch draft moves', () => {
  const destination = {
    sessionId: 'move-session',
    worktreeId: 'folder-workspace',
    executionHostId: 'ssh:remote' as const
  }
  const source = 'pending-chat'
  const target = structuredAgentSessionDraftScopeKey(destination.sessionId)

  afterEach(() => vi.restoreAllMocks())

  it('keeps the saved source after both destination storage and its journal refuse the move', async () => {
    const storage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    updateNativeChatComposerDraft(source, { text: 'Keep my draft' }, 'immediate')
    await nativeChatComposerDraftWritesSettled()
    storage.refuseWrites = true
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('refused', 'QuotaExceededError')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    moveStructuredAgentLaunchDraft(destination, source)
    await nativeChatComposerDraftWritesSettled()

    expect(readNativeChatComposerDraft(source).text).toBe('')
    expect(readNativeChatComposerDraft(target).text).toBe('Keep my draft')
    expect(isNativeChatComposerDraftUnsaved(target)).toBe(true)
    expect(storage.drafts.get(source)?.text).toBe('Keep my draft')
    expect(storage.drafts.has(target)).toBe(false)

    storage.refuseWrites = false
    flushNativeChatComposerDrafts()
    await nativeChatComposerDraftWritesSettled()
    expect(storage.drafts.get(target)?.text).toBe('Keep my draft')
    expect(storage.drafts.has(source)).toBe(false)
  })

  it.each([false, true])(
    'transfers live ownership immediately and keeps the saved source until commit: %s',
    async (edit) => {
      const storage = createMemoryNativeChatComposerDraftStorage()
      setNativeChatComposerDraftStorageForTests(storage)
      await hydrateNativeChatComposerDrafts()
      updateNativeChatComposerDraft(source, { text: 'Move this' }, 'immediate')
      await nativeChatComposerDraftWritesSettled()
      vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('refused', 'QuotaExceededError')
      })
      const committed = Promise.withResolvers<void>()
      const write = storage.write
      storage.write = async (scope, draft) => {
        if (scope === target) {
          await committed.promise
        }
        await write(scope, draft)
      }

      moveStructuredAgentLaunchDraft(destination, source)
      expect(storage.drafts.get(source)?.text).toBe('Move this')
      expect(readNativeChatComposerDraft(source).text).toBe('')
      expect(readNativeChatComposerDraft(target).text).toBe('Move this')
      if (edit) {
        updateNativeChatComposerDraft(target, { text: 'Move this plus newer typing' }, 'immediate')
      }
      committed.resolve()
      await nativeChatComposerDraftWritesSettled()

      expect(storage.drafts.get(target)?.text).toBe(
        edit ? 'Move this plus newer typing' : 'Move this'
      )
      expect(storage.drafts.has(source)).toBe(false)
      expect(readNativeChatComposerDraft(source).text).toBe('')
    }
  )

  it('does not retire the saved source when an older destination write commits', async () => {
    const storage = createMemoryNativeChatComposerDraftStorage()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    updateNativeChatComposerDraft(source, { text: 'Move this' }, 'immediate')
    await nativeChatComposerDraftWritesSettled()
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new DOMException('refused', 'QuotaExceededError')
    })
    const earlier = Promise.withResolvers<void>()
    const moved = Promise.withResolvers<void>()
    const write = storage.write
    let earlierWrite: Promise<void> | undefined
    storage.write = (scope, draft) => {
      const writing = (draft.text === 'Earlier destination' ? earlier.promise : moved.promise).then(
        () => write(scope, draft)
      )
      if (draft.text === 'Earlier destination') {
        earlierWrite = writing
      }
      return writing
    }
    updateNativeChatComposerDraft(target, { text: 'Earlier destination' }, 'immediate')
    moveStructuredAgentLaunchDraft(destination, source)

    earlier.resolve()
    await earlierWrite
    expect(storage.drafts.get(source)?.text).toBe('Move this')
    expect(readNativeChatComposerDraft(target).text).toBe('Earlier destination\n\nMove this')

    moved.resolve()
    await nativeChatComposerDraftWritesSettled()
    expect(storage.drafts.get(target)?.text).toBe('Earlier destination\n\nMove this')
    expect(storage.drafts.has(source)).toBe(false)
  })

  it('replays the moved rich draft over a destination read by delayed hydration', async () => {
    const storage = createMemoryNativeChatComposerDraftStorage()
    storage.drafts.set(target, { text: 'Already saved', images: [], savedAt: 1 })
    const loaded = Promise.withResolvers<ReadonlyMap<string, unknown>>()
    setNativeChatComposerDraftStorageForTests({ ...storage, loadAll: () => loaded.promise })
    const hydration = hydrateNativeChatComposerDrafts()
    const snapshot = new Map(storage.drafts)
    const document = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Follow up' }] }]
    }
    const images = [{ id: 'image', path: '/remote/image.png', connectionId: 'remote' }]
    updateNativeChatComposerDraft(source, { text: 'Follow up', document, images }, 'immediate')

    moveStructuredAgentLaunchDraft(destination, source, { from: 2, to: 5 })
    loaded.resolve(snapshot)
    await hydration
    await nativeChatComposerDraftWritesSettled()

    const merged = readNativeChatComposerDraft(target)
    expect(merged.text).toBe('Already saved\n\nFollow up')
    expect(merged.images).toEqual(images)
    expect(merged.document?.content?.at(-1)).toEqual(document.content[0])
    expect(nativeChatDraftPositions.get(merged)).toMatchObject({
      at: 'selection',
      from: 17,
      to: 20
    })
    expect(storage.drafts.get(target)).toMatchObject({ text: merged.text, images })
    expect(storage.drafts.has(source)).toBe(false)
  })
})
