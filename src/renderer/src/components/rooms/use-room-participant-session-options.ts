import { patchStructuredAgentSessionOptionSnapshot } from '../../../../shared/structured-agent-session-options'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { RoomParticipant } from '../../../../shared/rooms'
import type {
  SessionOptionDescriptor,
  SessionOptionValue,
  SessionOptionsSurface
} from '../../../../shared/native-chat-session-options'
import type {
  AgentSessionHistoryResult,
  AgentSessionMutationResult,
  AgentSessionOptionResult,
  AgentSessionOptionsResult
} from '../../../../shared/agent-session-wire'
import {
  createStructuredAgentSessionOperationId,
  structuredAgentSessionPayloadFingerprint
} from '../../../../shared/structured-agent-session-mutation'
import { createNativeChatPtySessionOptions } from '../native-chat/native-chat-pty-session-options'
import {
  discoverNativeChatCatalogModels,
  resolveRoomModelDiscoveryContext
} from '../native-chat/native-chat-session-option-discovery'
import {
  ensureNativeChatModelEnrichment,
  readNativeChatEnrichedModels,
  readNativeChatEnrichedReportedValues,
  subscribeNativeChatEnrichedModels
} from '../native-chat/native-chat-session-option-enrichment'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { reportRoomMachineContext } from './room-machine-session-option-reporting'

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): SessionOptionDescriptor[] => EMPTY_SNAPSHOT

export function useRoomParticipantSessionOptions(
  participant: RoomParticipant,
  target: RuntimeClientTarget
): {
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
  canCompact: boolean
  refreshMachineOptions: () => Promise<void>
} {
  const machineConversationId =
    participant.providerSession?.transport === 'machine' ? participant.providerSession.id : null
  const [machineOptions, setMachineOptions] = useState<SessionOptionDescriptor[]>(EMPTY_SNAPSHOT)
  const [machineFence, setMachineFence] = useState<number | null>(null)
  const [machineCanCompact, setMachineCanCompact] = useState(false)
  const machineRequestRef = useRef(0)
  const refreshMachineOptions = useCallback(async (): Promise<void> => {
    if (!machineConversationId) {
      return
    }
    const request = ++machineRequestRef.current
    try {
      const [options, history] = await Promise.all([
        callStructuredAgentSession<AgentSessionOptionsResult>(target, 'agentSession.options', {
          sessionId: machineConversationId
        }),
        callStructuredAgentSession<AgentSessionHistoryResult>(target, 'agentSession.history', {
          sessionId: machineConversationId,
          direction: 'tail',
          limit: 1
        })
      ])
      if (machineRequestRef.current !== request) {
        return
      }
      setMachineOptions(options.descriptors ?? EMPTY_SNAPSHOT)
      setMachineCanCompact(options.canCompact === true)
      setMachineFence(history.page.fence ?? null)
    } catch (error) {
      if (machineRequestRef.current === request) {
        console.warn('[rooms] failed to read structured session options', error)
      }
    }
  }, [machineConversationId, target])
  useEffect(() => {
    machineRequestRef.current += 1
    setMachineOptions(EMPTY_SNAPSHOT)
    setMachineFence(null)
    setMachineCanCompact(false)
    void refreshMachineOptions()
    return () => {
      machineRequestRef.current += 1
    }
  }, [machineConversationId, participant.state, refreshMachineOptions])
  const agent = participant.agent
  const discoveryContext = useMemo(
    () =>
      participant.worktreeId ? resolveRoomModelDiscoveryContext(participant.worktreeId) : null,
    [participant.worktreeId]
  )
  const attached = Boolean(participant.terminalHandle)
  const surface = useMemo(() => {
    if (!agent || !attached) {
      return null
    }
    return createNativeChatPtySessionOptions({
      agent,
      scopeKey: `room:${participant.id}`,
      ...(discoveryContext
        ? {
            initialModels:
              readNativeChatEnrichedModels(agent, discoveryContext.hostKey) ?? undefined
          }
        : {}),
      mode: 'live',
      restartAgentPickerOptions: true,
      reportedValues: discoveryContext
        ? readNativeChatEnrichedReportedValues(agent, discoveryContext.hostKey)
        : null,
      dispatchCommand: async (command) => {
        await roomRpc(target, 'rooms.participants.control', {
          participantId: participant.id,
          command
        })
        return /^\/fast (?:on|off)$/.test(command.trim()) ? { outcome: 'applied' } : undefined
      },
      restartSession: async (values: Record<string, SessionOptionValue>) => {
        await roomRpc(target, 'rooms.participants.configure', {
          participantId: participant.id,
          ...(typeof values.model === 'string' ? { model: values.model } : {}),
          ...(typeof values.effort === 'string' ? { effort: values.effort } : {}),
          ...(typeof values.fastMode === 'boolean'
            ? { mode: values.fastMode ? 'fast' : 'standard' }
            : {})
        })
      }
    })
  }, [agent, attached, discoveryContext, participant.id, target])

  useEffect(() => {
    const model = participant.context.model?.trim()
    const effort = participant.context.effort?.trim()
    const contextWindow =
      agent === 'claude' && participant.context.maxTokens !== null
        ? participant.context.maxTokens >= 1_000_000
          ? '1m'
          : 'standard'
        : null
    const fastMode = participant.context.fastMode
    if (surface && (model || effort || contextWindow || typeof fastMode === 'boolean')) {
      const currentModel = surface.getSnapshot().find((descriptor) => descriptor.id === 'model')
        ?.kind.currentValue
      const authoritativeModel = model || currentModel
      if (authoritativeModel) {
        surface.reportSessionOptions({
          model: authoritativeModel,
          ...(effort ? { effort } : {}),
          ...(contextWindow ? { contextWindow } : {}),
          ...(typeof fastMode === 'boolean' ? { fastMode } : {})
        })
      }
    }
  }, [
    agent,
    participant.context.effort,
    participant.context.fastMode,
    participant.context.maxTokens,
    participant.context.model,
    surface
  ])

  useEffect(() => {
    if (!surface || !agent || !discoveryContext) {
      return
    }
    const unsubscribe = subscribeNativeChatEnrichedModels(
      agent,
      discoveryContext.hostKey,
      ({ models, reportedValues }) => {
        surface.replaceModels(models)
        const currentModel = surface.getSnapshot().find((option) => option.id === 'model')
          ?.kind.currentValue
        if (!currentModel && reportedValues) {
          surface.reportSessionOptions(reportedValues)
        }
      }
    )
    ensureNativeChatModelEnrichment({
      agent,
      hostKey: discoveryContext.hostKey,
      discover: () => discoverNativeChatCatalogModels(agent, discoveryContext.runtime)
    })
    return unsubscribe
  }, [agent, discoveryContext, surface])

  const snapshot = useSyncExternalStore(
    surface?.subscribe ?? subscribeEmpty,
    surface?.getSnapshot ?? getEmptySnapshot,
    surface?.getSnapshot ?? getEmptySnapshot
  )
  const reportedMachineOptions = useMemo(
    () => reportRoomMachineContext(machineOptions, participant),
    [machineOptions, participant]
  )
  const machineSurface = useMemo(
    () =>
      machineConversationId && machineFence !== null
        ? createMachineSessionOptionsSurface({
            target,
            sessionId: machineConversationId,
            fence: machineFence,
            snapshot: reportedMachineOptions,
            onSnapshot: setMachineOptions
          })
        : null,
    [machineConversationId, machineFence, reportedMachineOptions, target]
  )
  return machineConversationId
    ? {
        surface: machineSurface,
        snapshot: reportedMachineOptions,
        canCompact: machineCanCompact,
        refreshMachineOptions
      }
    : { surface, snapshot, canCompact: true, refreshMachineOptions }
}

function createMachineSessionOptionsSurface(input: {
  target: RuntimeClientTarget
  sessionId: string
  fence: number
  snapshot: SessionOptionDescriptor[]
  onSnapshot: (snapshot: SessionOptionDescriptor[]) => void
}): SessionOptionsSurface {
  const setOption = async (id: string, value: SessionOptionValue) => {
    const stringValue = String(value)
    const fields = { key: id, value: stringValue }
    const result = await callStructuredAgentSession<
      AgentSessionMutationResult<AgentSessionOptionResult>
    >(input.target, 'agentSession.setOption', {
      envelope: {
        sessionId: input.sessionId,
        clientOperationId: createStructuredAgentSessionOperationId(() => crypto.randomUUID()),
        expectedRuntimeFence: input.fence,
        payloadFingerprint: structuredAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: input.sessionId,
          fields
        })
      },
      ...fields
    })
    if (!result.ok) {
      throw new Error(result.refusal.message)
    }
    const values = result.value.options ?? { [id]: stringValue }
    const reported = await callStructuredAgentSession<AgentSessionOptionsResult>(
      input.target,
      'agentSession.options',
      { sessionId: input.sessionId }
    ).catch(() => null)
    const snapshot =
      reported?.descriptors ?? patchStructuredAgentSessionOptionSnapshot(input.snapshot, values)
    input.onSnapshot(snapshot)
    return { snapshot }
  }
  return {
    getSnapshot: () => input.snapshot,
    setOption,
    invokeAction: async () => ({ snapshot: input.snapshot }),
    subscribe: () => () => {}
  }
}
