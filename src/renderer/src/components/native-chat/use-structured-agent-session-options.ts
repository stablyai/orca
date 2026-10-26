import { toast } from 'sonner'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { AgentSessionOptionResult } from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'
import type { SessionOptionsSurface } from '../../../../shared/native-chat-session-options'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-chat-permission-mode'
import {
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  lockedStructuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionSnapshot
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useRememberSessionOptionPicks } from './use-structured-agent-session-option-picks'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/structured-agent-session-option-codec'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useHostModelCatalogUpgrade } from './use-host-model-catalog-upgrade'
import { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import {
  getStructuredAgentSessionLaunchSelection,
  holdStructuredAgentSessionLaunchOption,
  type StructuredLaunchOptionOutcome
} from '@/lib/structured-agent-session-launch-options'

const NO_HELD_OPTIONS: Readonly<Record<string, string>> = {}

export function useStructuredAgentSessionOptions(args: {
  agent: AgentType
  sessionId: string
  target: RuntimeClientTarget
  transportEnabled: boolean
  isVisible: boolean
  providerVisible: boolean
  providerStarting?: boolean
  providerRunning?: boolean
  hostOptionStamp?: string
  fence: number | null
  turnId: string | null
  unloadedTurnRevisions: number | undefined
  mutate: StructuredAgentSessionMutate
  launch?: StructuredAgentSessionLaunchView
}) {
  const {
    agent,
    fence,
    launch,
    mutate,
    providerVisible,
    sessionId,
    target,
    transportEnabled,
    turnId
  } = args
  const providerStarting = args.providerStarting ?? false
  const newLaunch = launch?.kind === 'new'
  const launchSeedOptions = launch?.seedOptions
  const held = launch?.heldOptions ?? NO_HELD_OPTIONS
  const optionCatalog = useMemo(() => structuredAgentSessionSeedCatalog(agent), [agent])
  const {
    optionView,
    takesSendOptions,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    pendingOptionsRef,
    optionMutationGeneration,
    updateOptionState,
    receiveCatalog,
    beginOptionWrite,
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

  const rememberOptionPicks = useRememberSessionOptionPicks(target, agent)
  const sendStructuredOption = useCallback(
    async (id: string, encoded: string): Promise<boolean> => {
      const currentState = optionStateRef.current
      const targetRecord = currentState.record
      const finishWrite = beginOptionWrite(id)
      const mutationGeneration = ++optionMutationGeneration.current
      const sameRecord = (): boolean =>
        isCurrentContext() && activeOptionRecordRef.current === targetRecord
      const isCurrent = (): boolean =>
        sameRecord() && optionMutationGeneration.current === mutationGeneration
      const currentPick = (): boolean => isCurrent() || pendingOptionsRef.current[id] === encoded
      // Show record-only picks immediately while their writes wait behind provider startup.
      const shownAtOnce = providerStarting || id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
      if (shownAtOnce) {
        updateOptionState((current) =>
          commitStructuredAgentSessionOptionValues(current, { [id]: encoded })
        )
      } else {
        pendingOptionsRef.current[id] = encoded
        updateOptionState((current) => ({ ...current, pendingId: id }))
      }
      let result: AgentSessionOptionResult | null = null
      try {
        result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded }
        )
        if (result && sameRecord() && currentPick()) {
          const returned = result.options ?? { [id]: encoded }
          const committed = isCurrent() ? returned : { [id]: returned[id] ?? encoded }
          updateOptionState((current) =>
            current.record === targetRecord
              ? commitStructuredAgentSessionOptionValues(current, committed)
              : current
          )
          // The launch seed names the model an effort-only pick was made under.
          rememberOptionPicks(
            optionView(currentState, launchSeedOptions, NO_HELD_OPTIONS),
            committed
          )
        }
        return Boolean(result)
      } finally {
        if (sameRecord() && pendingOptionsRef.current[id] === encoded) {
          delete pendingOptionsRef.current[id]
        }
        if (isCurrent()) {
          updateOptionState((current) =>
            current.record === targetRecord && current.pendingId === id
              ? { ...current, pendingId: null }
              : current
          )
        }
        finishWrite(isCurrent() && Boolean(result || shownAtOnce))
      }
    },
    [
      activeOptionRecordRef,
      beginOptionWrite,
      isCurrentContext,
      launchSeedOptions,
      mutate,
      optionMutationGeneration,
      optionStateRef,
      optionView,
      pendingOptionsRef,
      providerStarting,
      rememberOptionPicks,
      updateOptionState
    ]
  )
  const settleLaunchOptionPick = useCallback(
    (outcome: StructuredLaunchOptionOutcome) => {
      if (outcome.kind === 'refused') {
        toast.error(agentSessionWriteFailureText(outcome.failure, 'option'))
      } else if (outcome.kind === 'accepted') {
        rememberOptionPicks(
          optionView(optionStateRef.current, launchSeedOptions, NO_HELD_OPTIONS),
          outcome.options
        )
      }
    },
    [launchSeedOptions, optionStateRef, optionView, rememberOptionPicks]
  )
  const lockSnapshotRef = useRef(
    (snapshot: ReturnType<typeof structuredAgentSessionOptionSnapshot>) => snapshot
  )
  const lockSnapshot = (snapshot: ReturnType<typeof structuredAgentSessionOptionSnapshot>) =>
    !acceptsPicks ? lockedStructuredAgentSessionOptionSnapshot(snapshot) : snapshot
  useLayoutEffect(() => {
    lockSnapshotRef.current = lockSnapshot
  })
  const optionSnapshot = lockSnapshot(
    structuredAgentSessionOptionSnapshot(optionView(optionState, launchSeedOptions, held))
  )
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      const view = optionView(optionStateRef.current, launchSeedOptions, held)
      const pickState = {
        ...view,
        pendingId: providerStarting || pendingOptionsRef.current[id] === undefined ? null : id
      }
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID &&
          value === 'own' &&
          !view.permissionOwnSupported) ||
        !isCurrentContext() ||
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(
          pickState,
          id,
          value,
          lockSnapshotRef.current(structuredAgentSessionOptionSnapshot(view))
        )
      ) {
        return false
      }
      if (!transportEnabled || fence === null) {
        // No fence yet: the launch holds it and applies it before anything else is sent.
        const applied = holdStructuredAgentSessionLaunchOption(sessionId, id, encoded, view)
        void applied?.then(settleLaunchOptionPick)
        return applied !== null
      }
      return sendStructuredOption(id, encoded)
    },
    [
      fence,
      held,
      launchSeedOptions,
      optionCatalog,
      isCurrentContext,
      optionStateRef,
      optionView,
      pendingOptionsRef,
      providerStarting,
      sendStructuredOption,
      sessionId,
      settleLaunchOptionPick,
      transportEnabled
    ]
  )
  const setOption = useCallback(
    async (id: string, value: string | boolean) => {
      await setStructuredOption(id, value)
      // Read held picks directly; an accepted launch pick may precede this render’s props.
      const currentHeld = getStructuredAgentSessionLaunchSelection(sessionId)?.held
      return {
        snapshot: lockSnapshotRef.current(
          structuredAgentSessionOptionSnapshot(
            optionView(optionStateRef.current, launchSeedOptions, currentHeld ?? NO_HELD_OPTIONS)
          )
        )
      }
    },
    [launchSeedOptions, optionStateRef, optionView, sessionId, setStructuredOption]
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
    sendSource: { optionStateRef, pendingOptionsRef, optionView, takesSendOptions },
    unavailable: hostCatalog.unavailable
  }
}
