import type { StructuredAgentSessionOptionsArgs } from './structured-agent-session-options-contract'
import { toast } from 'sonner'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'
import type { SessionOptionsSurface } from '../../../../shared/native-chat/input/native-chat-session-options'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-chat-permission-mode'
import {
  canSetStructuredAgentSessionOption,
  lockedStructuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionPicks
} from '../../../../shared/structured-agent-session-options'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/structured-agent-session-option-codec'
import { useHostModelCatalogUpgrade } from './use-host-model-catalog-upgrade'
import { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'
import {
  flushStructuredSessionSelectionOptions,
  holdStructuredAgentSessionLaunchOption
} from '@/lib/structured-agent-session-launch-options'

export type { StructuredAgentSessionOptionsArgs } from './structured-agent-session-options-contract'

export function useStructuredAgentSessionOptions(args: StructuredAgentSessionOptionsArgs) {
  const { agent, fence, launch, providerVisible, sessionId, target, transportEnabled, turnId } =
    args
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
    conversationSupport
  } = useStructuredAgentSessionOptionState({
    agent,
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

  const awaitingOptions =
    conversationSupport?.sessionId === sessionId && conversationSupport.fence !== fence
  const acceptsPicks =
    (!transportEnabled || fence !== null) && launch?.seedPending !== true && !awaitingOptions

  const hostCatalog = useHostModelCatalogUpgrade({
    agent,
    sessionId,
    target,
    optionCatalog,
    enabled: args.isVisible,
    // A resumed conversation may keep its own model, so only a new one runs the listed default.
    newLaunch,
    ...(launch?.worktree ? { worktree: launch.worktree } : {}),
    fence,
    turnId,
    reportedUnpickedModel:
      newLaunch && launchSeedOptions?.model === undefined && optionState.catalogSource === 'live',
    ...(args.providerRunning ? { providerRunning: true } : {}),
    activeOptionRecordRef,
    updateOptionState,
    receiveCatalog
  })

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
  const optionSnapshot = lockSnapshot(
    structuredAgentSessionOptionSnapshot(
      optionView(optionState, launchSeedOptions, launch?.explicitOptions)
    )
  )
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      const view = optionView(optionStateRef.current, launchSeedOptions, launch?.explicitOptions)
      const pickState = {
        ...view,
        pendingId:
          providerStarting ||
          id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID ||
          !controller.isPending(id)
            ? null
            : id
      }
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID &&
          value === 'own' &&
          !view.permissionOwnSupported) ||
        !isCurrentContext() ||
        !acceptsPicks ||
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(
          pickState,
          id,
          value,
          lockSnapshotRef.current(structuredAgentSessionOptionSnapshot(view)),
          interactionReadyRef.current
        )
      ) {
        return false
      }
      if (!transportEnabled || fence === null) {
        const applied = holdStructuredAgentSessionLaunchOption(sessionId, id, encoded, view)
        void applied?.then((outcome) => {
          if (outcome.kind === 'refused' && outcome.failure) {
            toast.error(agentSessionWriteFailureText(outcome.failure, 'option'))
          }
          rereadOptions()
        })
        return applied !== null
      }
      const context = structuredAgentSessionOptionPicks(view, { [id]: encoded })[0]?.modelId ?? null
      const presents = capturePresentation?.()
      const operation = controller.issue(id, encoded, context)
      updateOptionState((current) => ({
        ...current,
        pendingId: providerStarting || id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID ? null : id
      }))
      void flushStructuredSessionSelectionOptions(target, sessionId, fence, controller)
      const outcome = await operation.result
      updateOptionState((current) => ({
        ...current,
        pendingId: controller.pendingId()
      }))
      if (
        (outcome.kind === 'refused' || outcome.kind === 'unknown') &&
        outcome.failure &&
        (presents?.() ?? true)
      ) {
        toast.error(agentSessionWriteFailureText(outcome.failure, 'option'))
      }
      rereadOptions()
      return outcome.kind !== 'refused'
    },
    [
      controller,
      capturePresentation,
      acceptsPicks,
      fence,
      launch?.explicitOptions,
      launchSeedOptions,
      target,
      optionCatalog,
      isCurrentContext,
      optionStateRef,
      optionView,
      providerStarting,
      rereadOptions,
      sessionId,
      transportEnabled,
      updateOptionState
    ]
  )
  const setOption = useCallback(
    async (id: string, value: string | boolean) => {
      await setStructuredOption(id, value)
      return {
        snapshot: lockSnapshotRef.current(
          structuredAgentSessionOptionSnapshot(
            optionView(optionStateRef.current, launchSeedOptions, launch?.explicitOptions)
          )
        )
      }
    },
    [launch?.explicitOptions, launchSeedOptions, optionStateRef, optionView, setStructuredOption]
  )
  const optionSurface = useMemo<SessionOptionsSurface>(
    () => ({
      getSnapshot: () => optionSnapshot,
      demandModelCatalog: hostCatalog.demandModelCatalog,
      setOption,
      invokeAction: async () => ({ snapshot: optionSnapshot }),
      subscribe: () => () => {}
    }),
    [setOption, optionSnapshot, hostCatalog.demandModelCatalog]
  )

  const support =
    transportEnabled && conversationSupport?.sessionId === sessionId ? conversationSupport : null
  return {
    conversationCommands: support?.commands ?? [],
    /** Absent unless this host and session can change the goal. */
    threadGoal: support?.threadGoal,
    /** A goal only the agent's own `/goal` changes; absent from a host that predates it. */
    reportedThreadGoal: support?.reportedThreadGoal,
    /** Absent from a host that predates it or a session that writes no context facts. */
    contextUsage: support?.contextUsage,
    /** Absent from a host that predates it, and until the options read answers. */
    acceptsImages: support?.acceptsImages,
    /** Undefined until this fence's options read answers. */
    rewind: support?.fence === fence ? support.rewind : undefined,
    optionSnapshot,
    optionSurface,
    setStructuredOption,
    sendSource: { optionStateRef, optionView, takesSendOptions, takesSelection },
    unavailable: hostCatalog.unavailable
  }
}
