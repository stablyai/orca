import { expect, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type * as launchModule from '../structured-agent-session-launch-create-call'
import type { StructuredAgentLaunchHandle } from '../structured-agent-launch-settlement'
import type { OpenedAgentSessionTab } from '../structured-agent-session-tab-open-through-layout-owner'
import type { TabsDrawnFromMain } from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { getStructuredLaunchStateBySessionId } from './launch/structured-agent-session-launch-registry'
import {
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import { promptTextContent } from '@/components/native-chat/native-chat-prompt-document-text'
import {
  startStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch
} from '../structured-agent-session-launch'
import { trackStructuredLaunchConfirmationDeadline } from './launch/structured-agent-session-launch-prompt-outcome'
import { holdStructuredAgentSessionLaunchOption } from '../structured-agent-session-launch-options'
import * as sessionClient from '@/runtime/structured-agent-session-client'
import * as runtimeRpc from '@/runtime/runtime-rpc-client'
import { structuredSessionSelectionController } from '../structured-agent-session-selection-controller'
import type { SelectionOperation } from '../../../../shared/structured-agent-session-selection-operations'
import { structuredAgentSessionPayloadFingerprint } from '../../../../shared/structured-agent-session-mutation'

export async function assertProvisionalSelectionLifetime({
  launch,
  chat,
  main,
  accept,
  launchCall
}: {
  launch: Pick<StructuredAgentLaunchHandle, 'executionHostId' | 'settlement'>
  chat: OpenedAgentSessionTab
  main: Pick<TabsDrawnFromMain, 'settle'>
  accept: (receipt: Awaited<ReturnType<typeof launchModule.launchStructuredAgentSession>>) => void
  launchCall: ReturnType<typeof vi.fn>
}): Promise<void> {
  const optionResponse = Promise.withResolvers<unknown>()
  const optionCall = vi
    .spyOn(sessionClient, 'callStructuredAgentSession')
    .mockReturnValueOnce(optionResponse.promise)
  const rpcCall = vi.spyOn(runtimeRpc, 'callRuntimeRpc')
  const pending = getStructuredLaunchStateBySessionId(chat.entityId)
  let controller: ReturnType<typeof structuredSessionSelectionController> | undefined
  let operation: SelectionOperation | undefined
  let pick: ReturnType<typeof holdStructuredAgentSessionLaunchOption> = null
  let joined: ReturnType<typeof startStructuredAgentLaunch> | undefined
  let optionAnswered = false
  void optionResponse.promise.then(() => {
    optionAnswered = true
  })
  const scope = structuredAgentSessionDraftScopeKey(chat.entityId)
  const lateReply = { ok: true, value: { options: { model: 'picked' } } }
  try {
    await main.settle()
    expect(useAppStore.getState().getTab(chat.id)?.entityId).toBe(chat.entityId)
    if (!pending) {
      throw new Error('Missing original pending launch')
    }
    const intent = pending.intent
    const originalResult = pending.promise
    pending.intent.createMessageSupport = true
    controller = structuredSessionSelectionController(intent.target, chat.entityId, intent.agent)
    pick = holdStructuredAgentSessionLaunchOption(chat.entityId, 'model', 'picked')
    operation = controller.current('model')
    if (!operation || !pick) {
      throw new Error('Missing original held selection')
    }
    expect(operation.result).toBe(pick)
    expect(operation).toMatchObject({
      key: 'model',
      value: 'picked',
      model: 'picked',
      transmitted: false
    })
    expect(operation.request).toBeUndefined()
    expect(operation.outcome).toBeUndefined()
    expect(controller.isCurrent()).toBe(true)
    expect(controller.pending()).toEqual([operation])
    expect(controller.isPending('model')).toBe(true)
    expect(controller.pendingId()).toBe('model')
    expect(controller.overlay()).toEqual({ model: 'picked' })
    expect(optionAnswered).toBe(false)

    joined = startStructuredAgentLaunch('wt-1', 'claude', {
      requestId: 'after-success',
      prompt: 'hand-off context',
      promptDelivery: 'draft',
      resumeFrom: { providerSessionId: 'prior-chat' }
    })
    expect(joined.joined).toBe(true)
    expect(joined.sessionId).toBe(chat.entityId)
    expect(joined.executionHostId).toBe(launch.executionHostId)
    expect(joined.launchResult).toBe(originalResult)
    expect(pending.intent).toBe(intent)
    expect(getStructuredLaunchStateBySessionId(chat.entityId)).toBe(pending)
    expect(launchCall).toHaveBeenCalledOnce()
    expect(readNativeChatComposerDraft(scope).text).toBe('hand-off context')
    expect(readNativeChatComposerDraft(scope).document).toEqual(
      promptTextContent('hand-off context')
    )
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    trackStructuredLaunchConfirmationDeadline(pending, originalResult)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pending.visibilityUnknown).toBe(true)
    expect(pending.callers.outcome).toBe('unknown')
    expect(controller.current('model')).toBe(operation)
    expect(controller.overlay()).toEqual({ model: 'picked' })
    expect(operation.transmitted).toBe(false)
    expect(operation.outcome).toBeUndefined()
    expect(optionAnswered).toBe(false)
    vi.useRealTimers()
    accept({ sessionId: chat.entityId, fence: 1 })
    expect(await launch.settlement).toMatchObject({
      kind: 'structured',
      sessionId: chat.entityId
    })
    expect(await originalResult).toEqual({ sessionId: chat.entityId, fence: 1 })
    expect(await joined.launchResult).toEqual({ sessionId: chat.entityId, fence: 1 })
    await main.settle()
    expect(pending.visibilityUnknown).toBe(false)
    expect(pending.callers.outcome).toBe('published')
    expect(pending.hostListed).toBeUndefined()
    expect(getStructuredLaunchStateBySessionId(chat.entityId)).toBeUndefined()
    expect(controller.isCurrent()).toBe(true)
    expect(controller.current('model')).toBe(operation)
    expect(operation.result).toBe(pick)
    expect(controller.pending()).toEqual([operation])
    expect(controller.overlay()).toEqual({ model: 'picked' })
    expect(operation.transmitted).toBe(true)
    expect(operation.outcome).toBeUndefined()
    const request = operation.request
    if (!request) {
      throw new Error('Original selection request was not dispatched')
    }
    const writes = optionCall.mock.calls.filter(([, method]) => method === 'agentSession.setOption')
    expect(writes).toEqual([
      [
        { kind: 'local' },
        'agentSession.setOption',
        {
          envelope: {
            sessionId: chat.entityId,
            clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
            expectedRuntimeFence: 1,
            payloadFingerprint: structuredAgentSessionPayloadFingerprint({
              method: 'agentSession.setOption',
              sessionId: chat.entityId,
              fields: { key: 'model', value: 'picked' }
            })
          },
          key: 'model',
          value: 'picked'
        },
        {}
      ]
    ])
    expect(optionCall.mock.results[0]?.value).toBe(optionResponse.promise)
    expect(retryStructuredAgentSessionLaunch('wt-1', chat.entityId)).toBe(false)
    expect(getStructuredLaunchStateBySessionId(chat.entityId)).toBeUndefined()
    expect(launchCall).toHaveBeenCalledOnce()
    expect(controller.isCurrent()).toBe(true)
    expect(controller.current('model')).toBe(operation)
    expect(controller.overlay()).toEqual({ model: 'picked' })

    useAppStore.getState().closeUnifiedTab(chat.id)
    await main.settle()
    expect(useAppStore.getState().getTab(chat.id)).toBeNull()
    expect(controller.isCurrent()).toBe(false)
    expect(await pick).toEqual({ kind: 'superseded' })
    expect(operation.outcome).toEqual({ kind: 'superseded' })
    await controller.drain()
    expect(optionAnswered).toBe(false)
    expect(controller.current('model')).toBeUndefined()
    expect(controller.pending()).toEqual([])
    expect(controller.isPending('model')).toBe(false)
    expect(controller.pendingId()).toBeNull()
    expect(controller.overlay()).toEqual({})
    expect(controller.captureRead()).toEqual([])
    expect(readNativeChatComposerDraft(scope).text).toBe('hand-off context')
    expect(readNativeChatComposerDraft(scope).document).toEqual(
      promptTextContent('hand-off context')
    )
    expect(operation.request).toBe(request)
    optionResponse.resolve(lateReply)
    await expect(request).rejects.toEqual(new Error('Conversation selection owner retired.'))
    await optionResponse.promise
    await pick
    await controller.drain()
    await Promise.allSettled(
      [...optionCall.mock.results, ...rpcCall.mock.results].flatMap((result) =>
        result.type === 'return' ? [result.value] : []
      )
    )
    await main.settle()
    await nativeChatComposerDraftWritesSettled()
    expect(controller.isCurrent()).toBe(false)
    expect(operation.outcome).toEqual({ kind: 'superseded' })
    expect(controller.current('model')).toBeUndefined()
    expect(controller.pending()).toEqual([])
    expect(controller.overlay()).toEqual({})
    expect(controller.captureRead()).toEqual([])
    expect(useAppStore.getState().getTab(chat.id)).toBeNull()
    expect(getStructuredLaunchStateBySessionId(chat.entityId)).toBeUndefined()
    expect(launchCall).toHaveBeenCalledOnce()
    expect(readNativeChatComposerDraft(scope).text).toBe('hand-off context')
    expect(readNativeChatComposerDraft(scope).document).toEqual(
      promptTextContent('hand-off context')
    )
  } finally {
    vi.useRealTimers()
    try {
      try {
        accept({ sessionId: chat.entityId, fence: 1 })
        await Promise.allSettled([launch.settlement, pending?.promise, joined?.launchResult])
        await main.settle()
      } finally {
        try {
          if (useAppStore.getState().getTab(chat.id)) {
            useAppStore.getState().closeUnifiedTab(chat.id)
          }
          await main.settle()
        } finally {
          optionResponse.resolve(lateReply)
          await Promise.allSettled([
            optionResponse.promise,
            operation?.request,
            operation?.result,
            pick,
            controller?.drain()
          ])
          await Promise.allSettled(
            [...optionCall.mock.results, ...rpcCall.mock.results].flatMap((result) =>
              result.type === 'return' ? [result.value] : []
            )
          )
          await main.settle()
          await nativeChatComposerDraftWritesSettled()
        }
      }
    } finally {
      rpcCall.mockRestore()
      optionCall.mockRestore()
    }
  }
}
