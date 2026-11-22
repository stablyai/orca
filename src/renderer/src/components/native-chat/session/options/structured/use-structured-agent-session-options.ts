import { useNativeChatPaneLifetimeEffect } from '../../../pane/ownership/native-chat-pane-lifetime'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import type { StructuredAgentSessionOptionsArgs } from './structured-agent-session-options-contract'
import { toast } from 'sonner'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { structuredAgentSessionSeedCatalog } from '../../../../../../../shared/agent-session/options/model-catalog/structured-agent-session-seed-catalog'
import type { SessionOptionsSurface } from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import {
  lockedStructuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionSnapshot
} from '../../../../../../../shared/agent-session/options/view/structured-agent-session-option-snapshot'
import {
  createStructuredAgentSessionOptionsWriteOwner,
  structuredAgentSessionOptionAvailability
} from '../../../../../../../shared/agent-session/options/reconciliation/structured-agent-session-options-write-owner'
import { structuredAgentSessionShownSnapshot } from '../../../../../../../shared/agent-session/options/view/structured-agent-session-option-view'
import { useHostModelCatalogUpgrade } from '../catalog/use-host-model-catalog-upgrade'
import { useNativeChatCliUpdate } from '../../../host-access/native-chat-cli-update'
import { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'
import { agentSessionWriteFailureText } from '../../../messages/notices/agent-session-write-notice-text'
import {
  flushStructuredSessionSelectionOptions,
  holdStructuredAgentSessionLaunchOption
} from '@/lib/agent-session/launch/structured-agent-session-launch-options'

export function useStructuredAgentSessionOptions(args: StructuredAgentSessionOptionsArgs) {
  const { agent, fence, launch, providerVisible, sessionId, transportEnabled, turnId } = args
  const environmentId = args.target.kind === 'environment' ? args.target.environmentId : null
  const target = useMemo(() => runtimeTargetForOwnerEnvironment(environmentId), [environmentId])
  const capturePresentation = args.capturePresentation
  const providerStarting = args.providerStarting ?? false
  const newLaunch = launch?.kind === 'new'
  const launchSeedOptions = launch?.seedOptions
  const optionCatalog = useMemo(() => structuredAgentSessionSeedCatalog(agent), [agent])
  const {
    optionView,
    takesSendOptions,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    controller,
    takesSelection,
    updateOptionState,
    rereadOptions,
    receiveCatalog,
    isCurrentContext,
    conversationSupport: support,
    sessionSupport
  } = useStructuredAgentSessionOptionState({
    ...args,
    optionCatalog,
    identity: `${agent}:${sessionId}`,
    fence,
    sessionId,
    target,
    newLaunch,
    ...(launch?.worktree ? { worktree: launch.worktree } : {}),
    seedsModel: launchSeedOptions?.model !== undefined,
    providerVisible,
    providerStarting,
    hostOptionStamp: args.hostOptionStamp ?? '',
    // Before start only resumed chats have recorded model evidence; new chats must wait instead of showing a guess.
    readsBeforeStart: launch?.kind !== 'new',
    turnId,
    unloadedTurnRevisions: args.unloadedTurnRevisions
  })

  const acceptsPicks = (!transportEnabled || fence !== null) && launch?.seedPending !== true

  const interactionReadyRef = useRef(acceptsPicks)
  const lockSnapshotRef = useRef(
    (snapshot: ReturnType<typeof structuredAgentSessionOptionSnapshot>) => snapshot
  )
  const lockSnapshot = (snapshot: ReturnType<typeof structuredAgentSessionOptionSnapshot>) =>
    !acceptsPicks ? lockedStructuredAgentSessionOptionSnapshot(snapshot) : snapshot
  useLayoutEffect(() => {
    interactionReadyRef.current = acceptsPicks
    lockSnapshotRef.current = lockSnapshot
  })
  const renderedView = optionView(optionState, launchSeedOptions, launch?.explicitOptions)
  const optionSnapshot = structuredAgentSessionOptionAvailability({
    controller,
    view: renderedView,
    snapshot: lockSnapshot(structuredAgentSessionShownSnapshot(renderedView)),
    ready: acceptsPicks,
    providerStarting,
    isCurrentContext
  })
  const modelOption = optionSnapshot.find((row) => row.id === 'model')
  const hostCatalog = useHostModelCatalogUpgrade({
    agent,
    selectedModel: modelOption?.kind.type === 'select' ? modelOption.kind.currentValue : undefined,
    sessionId,
    target,
    optionCatalog,
    enabled: args.isVisible,
    // A resumed conversation may keep its own model, so only a new one runs the listed default.
    newLaunch,
    ...(launch?.worktree ? { worktree: launch.worktree } : {}),
    hasTurn: args.hasTurn,
    fence,
    turnId,
    reportedUnpickedModel:
      newLaunch && launchSeedOptions?.model === undefined && optionState.catalogSource === 'live',
    ...(args.providerRunning ? { providerRunning: true } : {}),
    activeOptionRecordRef,
    updateOptionState,
    receiveCatalog
  })

  const readWriteContext = () => {
    const view = optionView(optionStateRef.current, launchSeedOptions, launch?.explicitOptions)
    return {
      controller,
      record: optionStateRef.current.record,
      view,
      snapshot: lockSnapshotRef.current(structuredAgentSessionOptionSnapshot(view)),
      ready: acceptsPicks && interactionReadyRef.current,
      providerStarting,
      existingChat: !newLaunch || args.hasTurn === true,
      isCurrentContext,
      ...(!transportEnabled || fence === null
        ? {
            hold: (id: string, encoded: string, view: typeof optionState) =>
              holdStructuredAgentSessionLaunchOption(sessionId, id, encoded, view)
          }
        : {}),
      flush: () => {
        if (fence !== null) {
          void flushStructuredSessionSelectionOptions(target, sessionId, fence, controller)
        }
      },
      capturePresentation,
      presentFailure: (failure: Parameters<typeof agentSessionWriteFailureText>[0]) =>
        toast.error(agentSessionWriteFailureText(failure, 'option')),
      revalidate: rereadOptions,
      revalidateOn: 'settled' as const
    }
  }
  const writeContextRef = useRef(readWriteContext)
  useLayoutEffect(() => {
    writeContextRef.current = readWriteContext
  })
  const writer = useMemo(
    () => createStructuredAgentSessionOptionsWriteOwner(() => writeContextRef.current()),
    []
  )
  useNativeChatPaneLifetimeEffect(useCallback(() => () => writer.detach(), [writer]))
  const setStructuredOption = writer.setOption
  const setOption = useCallback(
    async (id: string, value: string | boolean) => {
      const applied = await setStructuredOption(id, value)
      return {
        ...(applied ? {} : { refused: true as const }),
        snapshot: lockSnapshotRef.current(
          structuredAgentSessionShownSnapshot(
            optionView(optionStateRef.current, launchSeedOptions, launch?.explicitOptions)
          )
        )
      }
    },
    [launch?.explicitOptions, launchSeedOptions, optionStateRef, optionView, setStructuredOption]
  )
  const { demandModelCatalog } = hostCatalog
  // The updated CLI lists the models it was too old for.
  const cliUpdate = useNativeChatCliUpdate(target, agent, demandModelCatalog)
  const cliUpdateModels = cliUpdate?.update?.models
  const cliUpdateAgent = cliUpdateModels?.length ? cliUpdate?.update?.agent : undefined
  const cliUpdateRunnable = cliUpdate?.update?.runnable === true
  const cliUpdatePhase = cliUpdate?.run?.phase ?? 'idle'
  const startCliUpdate = cliUpdate?.start
  const openCliUpdateFailure = cliUpdate?.openFailure
  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      demandModelCatalog,
      ...(cliUpdateAgent && cliUpdateModels && startCliUpdate && openCliUpdateFailure
        ? {
            cliUpdate: {
              agent: cliUpdateAgent,
              models: cliUpdateModels,
              runnable: cliUpdateRunnable,
              phase: cliUpdatePhase,
              start: () => void startCliUpdate(),
              openFailure: () => openCliUpdateFailure()
            }
          }
        : {}),
      admits: writer.admits,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [
      setOption,
      optionSnapshot,
      demandModelCatalog,
      writer,
      cliUpdateAgent,
      cliUpdateModels,
      cliUpdateRunnable,
      cliUpdatePhase,
      startCliUpdate,
      openCliUpdateFailure
    ]
  )

  return {
    conversationCommands: support?.commands ?? [],
    compactInstructions: support?.compactInstructions === true,
    /** Absent unless this host and session can change the goal. */
    accountUsage: support?.accountUsage,
    threadGoal: support?.threadGoal,
    /** A goal only the agent's own `/goal` changes; absent from a host that predates it. */
    reportedThreadGoal: support?.reportedThreadGoal,
    /** Absent from a host that predates it or a session that writes no context facts. */
    contextUsage: support?.contextUsage,
    /** Absent from a host that predates it, and until the options read answers. */
    ...sessionSupport,
    sessionSupport,
    /** Undefined until this fence's options read answers. */
    rewind: support?.fence === fence ? support.rewind : undefined,
    /** Undefined until this fence's options read answers, or from a host that predates forks. */
    forkSupport: support?.fence === fence ? support.forkSupport : undefined,
    optionSnapshot,
    optionSurface,
    setStructuredOption,
    sendSource: { optionStateRef, optionView, takesSendOptions, takesSelection },
    unavailable: hostCatalog.unavailable
  }
}
