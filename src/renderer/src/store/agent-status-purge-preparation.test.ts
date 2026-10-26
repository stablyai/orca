// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeOpenFile,
  makeTab,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from './slices/store-test-helpers'
import { getAgentStatusOwner } from './agent-status-commit'
import { applyAgentStatusPatch } from './agent-status-patch'
import { buildFullWorktreePurgeState } from './slices/worktrees/teardown/worktree-purge-state'
import { buildHostTwinPurgeState } from './slices/worktrees/teardown/host-twin-worktree-purge'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'
import {
  findStructuredAgentSessionReadOwner,
  resetStructuredAgentSessionReadOwnersForTests
} from '@/components/native-chat/structured-agent-session-read-owner-registry'
import {
  getStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends,
  subscribeToStructuredAgentSessionPendingSends
} from '@/components/native-chat/structured-agent-session-pending-sends'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import { stageStructuredLaunchPrompt } from '@/lib/structured-agent-session-launch-prompt'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import {
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests,
  writeStructuredAgentLaunchRecord
} from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import { awaitAgentLaunchPaneStart } from '@/lib/agent-launch-pane-start'
import {
  isUnlistedCreatedChat,
  recordUnlistedCreatedChat
} from '@/lib/structured-agent-session-unlisted-created-chats'
import {
  peekWebSessionFocusIntent,
  recordWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from '@/runtime/web-session-focus-intent'
import { structuredAgentSessionSendBody } from '../../../shared/structured-agent-session-send-mutation'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { structuredAgentSessionFocusOwner } from '@/runtime/structured-agent-session-owner'

const notice = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/closed-unsaved-files-toast', () => ({
  showClosedUnsavedFilesToast: notice
}))
vi.mock('../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
const workspace = 'repo1::/worktree',
  session = 'purge-chat',
  persisted = 'persisted-chat'
const leaf = '11111111-1111-4111-8111-111111111111'
const target = { kind: 'local' } as const
const focusOwner = structuredAgentSessionFocusOwner(target)
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  localStorage.clear()
  notice.mockClear()
  resetStructuredAgentLaunchRegistryForTests()
  resetStructuredAgentLaunchPersistenceForTests()
  resetWebSessionFocusIntentForTests()
})
afterEach(() => {
  resetStructuredAgentSessionReadOwnersForTests()
  resetStructuredAgentSessionSendsForTests()
  vi.useRealTimers()
})

describe('purge ownership preparation', () => {
  it.each(['full', 'host-twin'] as const)(
    '%s abort leaves source owners and dirty text; acceptance retires captured owners once',
    async (kind) => {
      const store = createTestStore(),
        owner = getAgentStatusOwner(store)
      const chat = makeUnifiedTab({
        id: `agent-session:${session}`,
        entityId: session,
        contentType: 'agent-session',
        executionHostId: 'local',
        worktreeId: workspace,
        groupId: 'g'
      })
      const shell = makeTab({
        id: 'launch-pane',
        worktreeId: workspace,
        ptyId: 'local-launch-pty',
        agentLaunchPane: { leafId: leaf }
      })
      const survivorPty = toRemoteRuntimePtyId('survivor-pty', 'survivor')
      const survivor = makeTab({ id: 'survivor-shell', worktreeId: workspace, ptyId: survivorPty })
      const survivorChat = makeUnifiedTab({
        id: 'agent-session:survivor-chat',
        entityId: 'survivor-chat',
        contentType: 'agent-session',
        executionHostId: 'runtime:survivor',
        worktreeId: workspace,
        groupId: 'g'
      })
      const survivorFile = makeOpenFile({
        id: 'survivor-file',
        worktreeId: workspace,
        runtimeEnvironmentId: 'survivor',
        isDirty: true
      })
      seedStore(store, {
        worktreesByRepo: {
          repo1: [
            makeWorktree({ id: workspace, repoId: 'repo1', hostId: 'local' }),
            ...(kind === 'host-twin'
              ? [makeWorktree({ id: workspace, repoId: 'repo1', hostId: 'runtime:survivor' })]
              : [])
          ]
        },
        tabsByWorktree: { [workspace]: [shell, ...(kind === 'host-twin' ? [survivor] : [])] },
        ptyIdsByTabId: {
          [shell.id]: ['local-launch-pty'],
          ...(kind === 'host-twin' ? { [survivor.id]: [survivorPty] } : {})
        },
        unifiedTabsByWorktree: {
          [workspace]: [chat, ...(kind === 'host-twin' ? [survivorChat] : [])]
        },
        openFiles: [
          makeOpenFile({
            id: '/worktree/dirty.ts',
            worktreeId: workspace,
            isDirty: true
          }),
          ...(kind === 'host-twin' ? [survivorFile] : [])
        ],
        editorDrafts: {
          '/worktree/dirty.ts': 'exact unsaved text',
          ...(kind === 'host-twin' ? { 'survivor-file': 'surviving unsaved text' } : {})
        }
      })
      setStructuredLaunchState({
        identity: 'purge launch',
        intent: {
          worktreeId: workspace,
          executionHostId: 'local',
          target,
          sessionId: session,
          agent: 'codex',
          surfaceAddress: { worktreeId: workspace, precedingTabIds: [] },
          params: {
            envelope: {
              sessionId: session,
              clientOperationId: 'operation',
              expectedRuntimeFence: null,
              payloadFingerprint: 'fingerprint'
            },
            worktree: `id:${workspace}`,
            agent: 'codex'
          }
        },
        promptDelivery: 'auto-submit',
        callers: {
          outcome: 'pending',
          attempt: { kind: 'first', requestId: 'purge', stagedPrompt: null },
          entries: new Set(),
          promptDeliveryResults: new Set(),
          onSettled: () => {}
        },
        promise: new Promise(() => {}),
        visibilityUnknown: false,
        cancelled: false,
        selection: { held: {} }
      })
      writeStructuredAgentLaunchRecord({
        sessionId: persisted,
        executionHostId: 'local',
        agent: 'codex',
        lifecycle: 'pending',
        clientOperationId: 'persisted-operation',
        payloadFingerprint: 'persisted-fingerprint',
        expectedRuntimeFence: null,
        surfaceAddress: { worktreeId: workspace, precedingTabIds: [] }
      })
      const prompt = stageStructuredLaunchPrompt(session, 'never sent'),
        discard = vi.spyOn(prompt, 'discard')
      const reader = getStructuredAgentSessionReadOwner(session, target),
        dispose = vi.spyOn(reader, 'dispose')
      recordUnlistedCreatedChat(workspace, session, 'local')
      recordWebSessionFocusIntent(focusOwner, workspace, chat.id)
      const settled = vi.fn()
      void awaitAgentLaunchPaneStart(shell.id, leaf).then(settled)
      const queued = {
        clientMessageId: 'queued',
        sessionId: session,
        body: structuredAgentSessionSendBody('queued text', []),
        previewUris: [],
        queuedAt: 1,
        phase: 'sending',
        issued: true
      } as const
      publishStructuredAgentSessionSends(session, { entries: [queued] })
      publishStructuredAgentSessionSends('survivor-chat', {
        entries: [{ ...queued, sessionId: 'survivor-chat' }]
      })
      const sendsChanged = vi.fn()
      const stopSends = subscribeToStructuredAgentSessionPendingSends(session, sendsChanged)
      const survivorReader = getStructuredAgentSessionReadOwner('survivor-chat', {
        kind: 'environment',
        environmentId: 'survivor'
      })
      const survivorDispose = vi.spyOn(survivorReader, 'dispose')
      const before = owner.getState(),
        launch = getStructuredLaunchStateBySessionId(session)
      const sends = getStructuredAgentSessionPendingSends(session),
        saved = readStructuredAgentLaunchRecord(persisted)
      const rawBefore = store.getState()
      const storage = localStorage
      const prematureWrites: string[] = []
      let acceptedWrites = 0
      const write = (method: 'setItem' | 'removeItem', key: string, value = '') => {
        if (store.getState() === rawBefore) {
          prematureWrites.push(method)
        } else {
          acceptedWrites++
        }
        if (method === 'setItem') {
          storage.setItem(key, value)
        } else {
          storage.removeItem(key)
        }
      }
      vi.stubGlobal('localStorage', {
        getItem: storage.getItem.bind(storage),
        setItem: (key: string, value: string) => write('setItem', key, value),
        removeItem: (key: string) => write('removeItem', key),
        clear: storage.clear.bind(storage)
      })
      const schedule = globalThis.setTimeout
      const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
        if (store.getState() === rawBefore) {
          prematureWrites.push('timer')
        }
        return schedule(...args)
      })
      const warn = console.warn
      const diagnostic = vi.spyOn(console, 'warn').mockImplementation((...args) => {
        if (store.getState() === rawBefore) {
          prematureWrites.push('diagnostic')
        }
        warn(...args)
      })
      const purge = () =>
        applyAgentStatusPatch(store, (state) =>
          kind === 'full'
            ? buildFullWorktreePurgeState(state, [{ id: workspace, hostId: 'local' }])
            : buildHostTwinPurgeState(state, 'local', new Map([[workspace, ['runtime:survivor']]]))
        )
      expect(() =>
        owner.transact(() => {
          purge()
          throw new Error('abort purge')
        })
      ).toThrow('abort purge')
      await Promise.resolve()
      expect(owner.getState()).toBe(before)
      expect(getStructuredLaunchStateBySessionId(session)).toBe(launch)
      expect(launch?.cancelled).toBe(false)
      expect(getStructuredAgentSessionPendingSends(session)).toBe(sends)
      expect(findStructuredAgentSessionReadOwner(session, target)).toBe(reader)
      expect(isUnlistedCreatedChat(workspace, session)).toBe(true)
      expect(peekWebSessionFocusIntent(focusOwner, workspace)?.hostTabId).toBe(chat.id)
      expect(readStructuredAgentLaunchRecord(persisted)).toBe(saved)
      expect(dispose).not.toHaveBeenCalled()
      expect(discard).not.toHaveBeenCalled()
      expect(settled).not.toHaveBeenCalled()
      expect(notice).not.toHaveBeenCalled()
      expect(sendsChanged).not.toHaveBeenCalled()
      expect(store.getState().editorBufferKeepRequest).toBe(before.editorBufferKeepRequest)
      const observed = vi.fn(() => {
        expect(getStructuredLaunchStateBySessionId(session)).toBeUndefined()
        expect(findStructuredAgentSessionReadOwner(session, target)).toBeUndefined()
        expect(getStructuredAgentSessionPendingSends(session)).toHaveLength(0)
        expect(peekWebSessionFocusIntent(focusOwner, workspace)).toBeNull()
        expect(isUnlistedCreatedChat(workspace, session)).toBe(false)
        expect(dispose).not.toHaveBeenCalled()
      })
      const unsubscribe = store.subscribe(observed)
      owner.transact(() => {
        purge()
        purge()
      })
      unsubscribe()
      await Promise.resolve()
      expect(observed).toHaveBeenCalledTimes(1)
      expect(dispose).toHaveBeenCalledTimes(1)
      timer.mockRestore()
      expect(acceptedWrites).toBeGreaterThan(0)
      diagnostic.mockRestore()
      vi.unstubAllGlobals()
      expect(prematureWrites).toEqual([])
      expect(discard).toHaveBeenCalledTimes(1)
      expect(sendsChanged).toHaveBeenCalledTimes(1)
      stopSends()
      expect(survivorDispose).not.toHaveBeenCalled()
      expect(getStructuredAgentSessionPendingSends('survivor-chat')).toHaveLength(1)
      expect(settled).toHaveBeenCalledExactlyOnceWith(null)
      expect(readStructuredAgentLaunchRecord(persisted)).toBeUndefined()
      await vi.waitFor(() => expect(notice).toHaveBeenCalledTimes(1))
      expect(notice.mock.calls[0][0]).toEqual([
        {
          fileId: '/worktree/dirty.ts',
          filePath: '/worktree/dirty.ts',
          content: 'exact unsaved text'
        }
      ])
      expect(notice.mock.calls[0][2]).toBe(1)
      if (kind === 'host-twin') {
        expect(store.getState().tabsByWorktree[workspace]).toEqual([survivor])
        expect(store.getState().unifiedTabsByWorktree[workspace]).toEqual([survivorChat])
        expect(store.getState().openFiles).toEqual([survivorFile])
        expect(store.getState().editorDrafts['survivor-file']).toBe('surviving unsaved text')
      }
    }
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
