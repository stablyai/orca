import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { roomRpc } from '@/runtime/runtime-rooms-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { RoomParticipant } from '../../../../shared/rooms'
import type {
  SessionOptionDescriptor,
  SessionOptionValue
} from '../../../../shared/native-chat-session-options'
import {
  createNativeChatPtySessionOptions,
  type NativeChatPtySessionOptionsSurface
} from '../native-chat/native-chat-pty-session-options'
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

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): SessionOptionDescriptor[] => EMPTY_SNAPSHOT

export function useRoomParticipantSessionOptions(
  participant: RoomParticipant,
  target: RuntimeClientTarget
): {
  surface: NativeChatPtySessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
} {
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
  return { surface, snapshot }
}
