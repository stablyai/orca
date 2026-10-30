// @vitest-environment happy-dom
import {
  mocks,
  launchIntent,
  sends,
  composerDraft
} from './structured-agent-session-launch.test-fixture'
import { describe, expect, it, vi } from 'vitest'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { hasStagedStructuredLaunchPrompt } from './structured-agent-session-launch-prompt'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
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
})
