import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import type { StructuredAgentSessionLaunchView } from './use-native-chat-provisional-launch'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { toast } from 'sonner'
import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { AgentSessionOptionResult } from '../../../../shared/agent-session-wire'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'
import type { SessionOptionsSurface } from '../../../../shared/native-chat/input/native-chat-session-options'
import { AGENT_CHAT_PERMISSION_MODE_OPTION_ID } from '../../../../shared/agent-chat-permission-mode'
import {
  canSetStructuredAgentSessionOption,
  commitStructuredAgentSessionOptionValues,
  lockedStructuredAgentSessionOptionSnapshot,
  structuredAgentSessionOptionSnapshot,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import { useRememberSessionOptionPicks } from './use-structured-agent-session-option-picks'
import {
  beginStructuredOptionPick,
  isLatestStructuredOptionPick,
  settleStructuredOptionPick,
  structuredOptionPickCommit,
  structuredOptionPickBlockingId
} from '../../../../shared/structured-agent-session-option-pick-book'
import { encodeStructuredAgentSessionOptionValue } from '../../../../shared/structured-agent-session-option-codec'
import { useHostModelCatalogUpgrade } from './use-host-model-catalog-upgrade'
import { useStructuredAgentSessionOptionState } from './use-structured-agent-session-option-state'
import { agentSessionWriteFailureText } from './agent-session-write-notice-text'
import {
  getStructuredAgentSessionLaunchSelection,
  holdStructuredAgentSessionLaunchOption,
  type StructuredLaunchOptionOutcome
} from '@/lib/structured-agent-session-launch-options'

export type StructuredAgentSessionOptionsArgs = {
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
}

const NO_HELD_OPTIONS: Readonly<Record<string, string>> = {}

export function useStructuredAgentSessionOptions(args: StructuredAgentSessionOptionsArgs) {
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
    optionPicks,
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

  const pendingView = useCallback(
    (state: StructuredAgentSessionOptionState) =>
      optionView(state, launchSeedOptions, held, launch?.explicitOptions),
    [held, launch?.explicitOptions, launchSeedOptions, optionView]
  )

  const rememberOptionPicks = useRememberSessionOptionPicks(target, agent)
  const sendStructuredOption = useCallback(
    async (id: string, encoded: string): Promise<boolean> => {
      const currentState = optionStateRef.current
      const targetRecord = currentState.record
      const finishWrite = beginOptionWrite(id)
      // Show record-only picks immediately while their writes wait behind provider startup.
      const shownAtOnce = providerStarting || id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID
      const pick = beginStructuredOptionPick(optionPicks.current, id, encoded, shownAtOnce)
      const sameRecord = (): boolean =>
        isCurrentContext() && activeOptionRecordRef.current === targetRecord
      const isCurrent = (): boolean =>
        sameRecord() && isLatestStructuredOptionPick(optionPicks.current, pick)
      updateOptionState((current) =>
        shownAtOnce
          ? commitStructuredAgentSessionOptionValues(current, { [id]: encoded })
          : { ...current, pendingId: id }
      )
      let result: AgentSessionOptionResult | null = null
      try {
        result = await mutate<AgentSessionOptionResult>(
          'agentSession.setOption',
          'agentSession.setOption',
          { key: id, value: encoded }
        )
        const committed =
          result && sameRecord()
            ? structuredOptionPickCommit(optionPicks.current, pick, result.options)
            : null
        if (committed) {
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
        if (sameRecord()) {
          settleStructuredOptionPick(optionPicks.current, pick)
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
      optionPicks,
      optionStateRef,
      optionView,
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
    structuredAgentSessionOptionSnapshot(pendingView(optionState))
  )
  const setStructuredOption = useCallback(
    async (id: string, value: string | boolean): Promise<boolean> => {
      const view = pendingView(optionStateRef.current)
      const encoded = encodeStructuredAgentSessionOptionValue(id, value)
      if (
        (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID &&
          value === 'own' &&
          !view.permissionOwnSupported) ||
        !isCurrentContext() ||
        !optionCatalog ||
        encoded === null ||
        !canSetStructuredAgentSessionOption(
          {
            ...view,
            pendingId: structuredOptionPickBlockingId(optionPicks.current, id, providerStarting)
          },
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
      optionCatalog,
      isCurrentContext,
      optionStateRef,
      optionPicks,
      pendingView,
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
    sendSource: { optionStateRef, optionPicks, optionView, takesSendOptions },
    unavailable: hostCatalog.unavailable
  }
}
