// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import { useAppStore } from '@/store'
import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'

vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))
vi.mock('@/runtime/workspace-layout/commands/layout-apply-send', () => ({
  recordLayoutApply: vi.fn()
}))
vi.mock('../../session/terminal/send/native-chat-runtime-send', () => ({
  sendNativeChatMessage: vi.fn(() => null),
  sendNativeChatTypedCommand: vi.fn(() => null),
  submitNativeChatPrompt: vi.fn()
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  clearNativeChatComposerDraftsForTests()
})

function fixture(contentType: 'terminal' | 'agent-session') {
  const store = createTestStore()
  store.setState({
    settings: { ...store.getState().settings!, tabBarOrderMode: 'mru' },
    activeWorktreeId: 'wt',
    activeGroupIdByWorktree: { wt: 'group' },
    groupsByWorktree: {
      wt: [
        makeTabGroup({ id: 'group', worktreeId: 'wt', activeTabId: 'a', tabOrder: ['a', 'b', 'c'] })
      ]
    },
    unifiedTabsByWorktree: {
      wt: ['a', 'b', 'c'].map((id) =>
        makeUnifiedTab({
          id,
          entityId: `entity-${id}`,
          contentType,
          worktreeId: 'wt',
          groupId: 'group'
        })
      )
    }
  })
  vi.spyOn(useAppStore, 'getState').mockImplementation(store.getState)
  return store
}

describe('chat submission tab recency', () => {
  it('keeps a later interaction ahead of an earlier prompt admitted afterwards', async () => {
    const store = fixture('agent-session')
    const admission = Promise.withResolvers<boolean>()
    const transport: NativeChatStructuredComposerTransport = {
      tabId: 'c',
      worktreeId: 'wt',
      capturePresentation: () => () => true,
      send: () => admission.promise,
      dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
      optionsSurface: {
        getSnapshot: () => [],
        setOption: async () => ({ snapshot: [] }),
        invokeAction: async () => ({ snapshot: [] }),
        subscribe: () => () => {}
      },
      optionSnapshot: [],
      onError: () => {},
      runtime: 'remote',
      sessionId: 'session-c',
      runtimeEnvironmentId: 'ssh-host'
    }
    const hook = renderHook(() =>
      useNativeChatStructuredComposerSend({
        agent: 'codex',
        draftScopeKey: 'session-c',
        imageAttachments: [],
        structuredTransport: transport,
        isComposing: () => false,
        clearSkillOrigin: () => {},
        setDraft: () => {},
        setCaret: () => {}
      })
    )
    let sending: Promise<boolean> | undefined
    act(() => {
      sending = hook.result.current('hello')
    })
    store.getState().recordTabInteraction('b', { worktreeId: 'wt' })
    await act(async () => {
      admission.resolve(true)
      expect(await sending).toBe(true)
    })
    expect(store.getState().groupsByWorktree.wt[0].tabOrder).toEqual(['b', 'a', 'c'])
  })

  it('promotes a synced terminal whose entity ID differs from its unified tab ID', () => {
    const store = fixture('terminal')
    const hook = renderHook(() =>
      useNativeChatPtyComposerSend({
        agent: 'codex',
        draft: 'hello',
        draftScopeKey: 'entity-c',
        imageAttachments: [],
        disabled: false,
        isDispatchingSessionOption: false,
        launchDraftResolved: true,
        resolveTarget: () => ({ ptyId: 'pty-c' }),
        classifySend: () => 'chat',
        sessionOptionsSurface: null,
        terminalTabId: 'entity-c',
        trackPendingSend: () => {},
        setDraft: () => {},
        setCaret: () => {},
        clearSkillOrigin: () => {},
        clearImageAttachments: () => {},
        setNotice: () => {}
      })
    )
    act(() => {
      expect(hook.result.current()).toBe(true)
    })
    expect(store.getState().groupsByWorktree.wt[0].tabOrder).toEqual(['c', 'a', 'b'])
  })
})
