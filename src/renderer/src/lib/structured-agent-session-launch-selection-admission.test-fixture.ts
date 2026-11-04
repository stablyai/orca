import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useStructuredAgentSessionOptions } from '@/components/native-chat/use-structured-agent-session-options'
import { writeNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/native-chat-composer-draft-store'
import { getStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/use-native-chat-provisional-launch'
import {
  getStructuredAgentSessionPendingSends,
  structuredAgentSessionSendOut
} from '@/components/native-chat/structured-agent-session-pending-sends'
import { structuredConversationCommandRunner } from '@/components/native-chat/structured-conversation-command-send'
import { sendMessageToAgent } from './agent-message-send'
import { recordHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { getStructuredLaunchStateBySessionId } from './agent-session/launch/structured-agent-session-launch-registry'
import { structuredSessionSelectionController } from './structured-agent-session-selection-controller'
import {
  mocks,
  deferred,
  start,
  createParams,
  target,
  created,
  draft
} from './structured-agent-session-launch-create-message.test-fixture'

export function registerCreateSelectionAdmissionTests(): void {
  it.each([
    { key: 'model', afterFreeze: false },
    { key: 'effort', afterFreeze: false },
    { key: 'model', afterFreeze: true }
  ] as const)(
    'admits a new $key pick after unknown create completion with a later held pick=$afterFreeze',
    async ({ key, afterFreeze }) => {
      const models = ['gpt-5.3-codex', 'gpt-5.4', 'gpt-5.5'].map((id) => ({
        id,
        label: id,
        isDefault: id === 'gpt-5.5',
        efforts: ['low', 'high'].map((value) => ({ value, label: value }))
      }))
      recordHostModelCatalogSnapshot(target, 'codex', null, {
        origin: 'probe',
        fetchedAt: 1,
        defaultHoldsInEveryWorkspace: true,
        models
      })
      const create = deferred<unknown>()
      const applied = deferred<unknown>()
      const refused = deferred<unknown>()
      const notesReply = deferred<unknown>()
      let optionReply = applied.promise
      let current = { model: 'gpt-5.4', effort: 'high' }
      mocks.call.mockImplementation((_target, method) => {
        if (method === 'agentSession.create') {
          return create.promise
        }
        if (method === 'agentSession.history') {
          return Promise.resolve({ ok: true, page: created().value.page })
        }
        if (method === 'agentSession.send') {
          return notesReply.promise
        }
        if (method === 'agentSession.setOption') {
          return optionReply
        }
        if (method === 'agentSession.options') {
          return Promise.resolve({ models, current })
        }
        if (method === 'agentSession.modelCatalog') {
          return Promise.resolve({ origin: 'live-session', fetchedAt: 1, models })
        }
        return new Promise(() => {})
      })
      const launch = start()
      const { result, rerender, unmount } = renderHook(
        ({ ready }) =>
          useStructuredAgentSessionOptions({
            agent: 'codex',
            sessionId: launch.sessionId,
            target,
            transportEnabled: ready,
            providerVisible: ready,
            providerStarting: !ready,
            isVisible: false,
            fence: ready ? 1 : null,
            turnId: null,
            unloadedTurnRevisions: undefined,
            mutate: async () => null,
            launch: { kind: 'new' }
          }),
        { initialProps: { ready: false } }
      )
      await act(async () => {
        expect(await result.current.setStructuredOption('model', 'gpt-5.4')).toBe(true)
        expect(await result.current.setStructuredOption('effort', 'high')).toBe(true)
      })
      await vi.waitFor(() => expect(createParams().firstMessage).toBeDefined())
      const original = structuredClone(createParams())
      expect(original.options).toEqual({ model: 'gpt-5.4', effort: 'high' })
      const owner = structuredSessionSelectionController(target, launch.sessionId, 'codex')
      const frozen = owner.pending()
      expect(frozen).toHaveLength(2)
      expect(frozen.every((operation) => operation.transmitted)).toBe(true)
      if (afterFreeze) {
        await act(async () => {
          expect(await result.current.setStructuredOption(key, 'gpt-5.3-codex')).toBe(true)
        })
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      await expect(launch.launchResult).rejects.toThrow('Opening message outcome unknown.')
      await expect(launch.promptDeliveryResult).resolves.toMatchObject({
        delivered: false,
        unconfirmed: true
      })
      expect(frozen.map((operation) => operation.outcome)).toEqual([
        { kind: 'unknown' },
        { kind: 'unknown' }
      ])
      const complete = vi.fn()
      void launch.promptDeliveryResult?.then(complete)
      rerender({ ready: true })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(result.current.sendSource.optionStateRef.current.optionsAnswerPresent).toBe(true)
      if (afterFreeze) {
        const provisional = renderHook(() =>
          useNativeChatProvisionalLaunch('workspace-1', launch.sessionId)
        )
        expect(provisional.result.current).toMatchObject({
          starting: false,
          transportEnabled: true,
          lifecycle: null
        })
        expect(structuredAgentSessionSendOut(launch.sessionId)).toBe(false)
        const readOwner = getStructuredAgentSessionReadOwner(launch.sessionId, target)
        await readOwner.admit(
          'switch-after-opening',
          () => true,
          (admission) => {
            expect(admission.busy()).toBe(false)
          }
        )
        const pending = { current: false }
        const commandSend = vi.fn(async () => ({ kind: 'dropped' as const }))
        const command = structuredConversationCommandRunner({
          agentName: 'Codex',
          pending,
          commandsWait: false,
          chat: {
            turnId: null,
            isWorking: false,
            queueSendsNext: false,
            backgroundTasks: { isMonitoring: false, show: false },
            submissions: []
          },
          prompts: [],
          rewindInFlight: { current: false },
          sends: getStructuredAgentSessionPendingSends(launch.sessionId),
          items: () => [],
          send: commandSend
        })
        await expect(command.runConversationCommand('clear')).resolves.toEqual({
          accepted: false,
          error: null
        })
        expect(commandSend).toHaveBeenCalledOnce()
        expect(pending.current).toBe(false)
        mocks.tabs = [
          {
            id: 'opening-tab',
            entityId: launch.sessionId,
            contentType: 'agent-session',
            executionHostId: 'local',
            worktreeId: 'workspace-1',
            groupId: 'group-1',
            label: 'Codex Chat',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
        const notes = sendMessageToAgent({
          worktreeId: 'workspace-1',
          target: { kind: 'structured-session', sessionId: launch.sessionId },
          prompt: 'Review the next full notes without resending the opening.'
        })
        await vi.waitFor(() => expect(structuredAgentSessionSendOut(launch.sessionId)).toBe(true))
        await readOwner.admit(
          'switch-during-notes',
          () => true,
          (admission) => {
            expect(admission.busy()).toBe(true)
          }
        )
        notesReply.resolve({
          ok: false,
          refusal: {
            code: 'agent_session_conflict',
            message: 'The host queue sends first.',
            details: { reason: 'queuedMessagesAhead' }
          }
        })
        await expect(notes).resolves.toEqual({
          status: 'not-writable',
          code: 'session-send-refused'
        })
        expect(structuredAgentSessionSendOut(launch.sessionId)).toBe(false)
        expect(getStructuredAgentSessionPendingSends(launch.sessionId)).toMatchObject([
          { clientMessageId: original.firstMessage?.clientMessageId, phase: 'unconfirmed' }
        ])
        provisional.unmount()
      }
      const newer = key === 'model' ? 'gpt-5.5' : 'low'
      let choice!: Promise<boolean>
      act(() => {
        choice = result.current.setStructuredOption(key, newer)
      })
      const writes = () =>
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.setOption')
      expect(writes()).toHaveLength(1)
      expect(writes()[0]?.[2]).toMatchObject({ key, value: newer })
      const live = owner.current(key)
      expect(live).not.toBe(frozen.find((operation) => operation.key === key))
      expect(owner.isPending(key)).toBe(true)
      await act(async () => {
        expect(
          await result.current.setStructuredOption(key, key === 'model' ? 'gpt-5.4' : 'high')
        ).toBe(false)
      })
      expect(writes()).toHaveLength(1)
      writeNativeChatDraftCache(
        structuredAgentSessionDraftScopeKey(launch.sessionId),
        'newer draft'
      )
      const raw = getStructuredLaunchStateBySessionId(launch.sessionId)?.promise
      await act(async () => {
        create.resolve(created(original))
        await raw
      })
      expect(owner.current(key)).toBe(live)
      expect(owner.isPending(key)).toBe(true)
      expect(live?.outcome).toBeUndefined()
      expect(createParams()).toEqual(original)
      const read = getStructuredAgentSessionReadOwner(launch.sessionId, target).getSnapshot().state
      expect(
        read.submissions.some(
          (row) => row.clientMessageId === original.firstMessage?.clientMessageId
        )
      ).toBe(true)
      current = { ...current, [key]: newer }
      await act(async () => {
        applied.resolve({ ok: true, value: { options: current } })
        expect(await choice).toBe(true)
      })
      expect(live?.outcome).toMatchObject({ kind: 'accepted', options: current })
      optionReply = refused.promise
      let rejected!: Promise<boolean>
      act(() => {
        rejected = result.current.setStructuredOption(key, key === 'model' ? 'gpt-5.4' : 'high')
      })
      expect(writes()).toHaveLength(2)
      await act(async () => {
        refused.resolve({
          ok: false,
          refusal: {
            code: 'agent_session_operation_invalid',
            details: { reason: 'optionRejected' }
          }
        })
        expect(await rejected).toBe(false)
      })
      expect(owner.isPending(key)).toBe(false)
      expect(complete).toHaveBeenCalledOnce()
      expect(draft(launch.sessionId)).toBe('newer draft')
      expect(
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
      ).toHaveLength(1)
      expect(
        mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.send')
      ).toHaveLength(afterFreeze ? 1 : 0)
      unmount()
    }
  )
}
