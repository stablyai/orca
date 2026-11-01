import {
  structuredSessionSelectionAuthority,
  structuredSessionSelectionController
} from '@/lib/structured-agent-session-selection-controller'
import { useStructuredSessionSelectionReads } from './use-structured-session-selection-reads'
import { projectRuntimePermission } from '../../../../shared/agent-session/options/structured-agent-session-permission-option'
import { useStructuredAgentSessionStatusSummary } from './StructuredAgentSessionStatusBridge'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/agent-session-options-result'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog-types'
import { usesInstalledAgentModelCatalog } from '../../../../shared/agent-model-catalog-ownership'
import { AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY } from '../../../../shared/agent-session/structured-agent-session-surface-capabilities'
import type { StructuredAgentSessionOptionState } from '../../../../shared/agent-session/options/structured-agent-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { structuredAgentSessionOptionView } from '../../../../shared/agent-session/options/structured-agent-session-option-view'
import {
  AGENT_SESSION_SEND_SELECTION_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY
} from '../../../../shared/agent-session/agent-session-create-capabilities'
import {
  useStructuredAgentSessionHostCapability,
  useStructuredAgentSessionOwnPermissionState,
  structuredAgentSessionHostKey
} from '@/runtime/structured-agent-session-host-capability'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { createStructuredAgentSessionOptionsReadOwner } from '../../../../shared/structured-agent-session-options-read-owner'

export { firstFrameOptionState } from './structured-agent-session-option-first-frame'
import { firstFrameOptionState } from './structured-agent-session-option-first-frame'

/** The picker's option state for one session: seeded, kept across its fences, re-read each turn. */
export function useStructuredAgentSessionOptionState(args: {
  agent: AgentType
  transportEnabled: boolean
  optionCatalog: AgentSessionOptionCatalog | null
  identity: string
  fence: number | null
  sessionId: string
  target: RuntimeClientTarget
  /** Launch context used to read the host’s saved model listing. */
  newLaunch: boolean
  worktree?: string
  seedsModel: boolean
  providerVisible: boolean
  providerStarting: boolean
  /** The option values the host's status carries: a pick made on another device moves it. */
  hostOptionStamp: string
  readsBeforeStart: boolean
  turnId: string | null
  unloadedTurnRevisions: number | undefined
}) {
  const {
    agent,
    fence,
    identity,
    newLaunch,
    optionCatalog,
    seedsModel,
    providerStarting,
    providerVisible,
    readsBeforeStart,
    sessionId,
    target,
    worktree
  } = args
  const { summary, observation } = useStructuredAgentSessionStatusSummary(sessionId, target)
  const [reader] = useState(() =>
    createStructuredAgentSessionOptionsReadOwner(
      firstFrameOptionState(agent, target, {
        newLaunch,
        seedsModel,
        ...(worktree ? { worktree } : {})
      })
    )
  )
  const { optionState } = useSyncExternalStore(reader.subscribe, reader.getSnapshot)
  const authority = structuredSessionSelectionAuthority(target)
  const controller = structuredSessionSelectionController(target, sessionId, agent)
  const hostKey = structuredAgentSessionHostKey(target)
  const owner = useMemo(
    () => [agent, sessionId, hostKey, identity, controller],
    [agent, sessionId, hostKey, identity, controller]
  )
  const acceptedSupport = reader.supportFor(owner)
  // Projected once per accepted answer so consumers keep stable references between answers.
  const conversationSupport = useMemo(
    () =>
      acceptedSupport && acceptedSupport.sessionId !== null
        ? {
            sessionId: acceptedSupport.sessionId,
            commands: acceptedSupport.result.conversationCommands ?? [],
            threadGoal: acceptedSupport.result.threadGoal,
            reportedThreadGoal: acceptedSupport.result.reportedThreadGoal,
            contextUsage: acceptedSupport.result.contextUsage,
            acceptsImages: acceptedSupport.result.acceptsImages,
            canSwitchAccount: acceptedSupport.result.canSwitchAccount === true,
            rewind: acceptedSupport.result.rewind ?? {
              supported: false as const,
              reason: 'unsupported' as const
            },
            fence: acceptedSupport.fence
          }
        : null,
    [acceptedSupport]
  )
  const contextRefresh = conversationSupport?.contextUsage ? (args.unloadedTurnRevisions ?? 0) : 0
  const {
    optionStateRef,
    activeOptionRecordRef,
    updateOptionState,
    receiveCatalog,
    invalidate: rereadOptions
  } = reader
  const takesSelection = useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_SEND_SELECTION_RUNTIME_CAPABILITY
  )
  const contextKey = JSON.stringify([identity, hostKey, newLaunch, worktree, fence, observation])
  const contextRef = useRef(contextKey)
  useEffect(() => {
    contextRef.current = contextKey
  }, [contextKey])
  const isCurrentContext = useCallback(() => contextRef.current === contextKey, [contextKey])
  const coherentCatalog = usesInstalledAgentModelCatalog(
    agent,
    useStructuredAgentSessionHostCapability(target, AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY)
  )
  useEffect(
    () =>
      reader.attach({
        owner,
        reset: [contextKey, authority],
        sessionId,
        fence,
        seed: () =>
          firstFrameOptionState(agent, target, {
            newLaunch,
            seedsModel,
            ...(worktree ? { worktree } : {})
          }),
        controller,
        eligible:
          providerVisible &&
          (!providerStarting || readsBeforeStart || takesSelection) &&
          optionCatalog !== null,
        optionCatalog,
        newLaunch,
        coherentCatalog,
        authority: () => structuredSessionSelectionAuthority(target),
        isCurrent: () => isCurrentContext() && controller.isCurrent(),
        request: () =>
          controller.request((options) =>
            callStructuredAgentSession<AgentSessionOptionsResult>(
              target,
              'agentSession.options',
              { sessionId },
              options
            )
          )
      }),
    [
      reader,
      owner,
      agent,
      sessionId,
      hostKey,
      identity,
      controller,
      contextKey,
      authority,
      fence,
      target,
      newLaunch,
      seedsModel,
      worktree,
      providerVisible,
      providerStarting,
      readsBeforeStart,
      takesSelection,
      optionCatalog,
      coherentCatalog,
      isCurrentContext
    ]
  )

  const seenContextRefresh = useRef(contextRefresh)
  useEffect(() => {
    if (contextRefresh !== seenContextRefresh.current) {
      seenContextRefresh.current = contextRefresh
      rereadOptions()
    }
  }, [contextRefresh, rereadOptions])
  useStructuredSessionSelectionReads({
    controller,
    target,
    authority,
    hostOptionStamp: args.hostOptionStamp,
    turnId: args.turnId,
    rereadOptions
  })
  const permissionOwnSupport = useStructuredAgentSessionOwnPermissionState(target)
  const permissionOwnSupported =
    permissionOwnSupport === 'unknown' ? null : permissionOwnSupport === 'supported'
  const optionView = useCallback(
    (
      state: StructuredAgentSessionOptionState,
      seed: Readonly<Record<string, string>> | undefined,
      explicit?: Readonly<Record<string, string>>
    ) => ({
      ...projectRuntimePermission(
        structuredAgentSessionOptionView(state, seed, controller.overlay(), explicit),
        summary,
        fence
      ),
      permissionOwnSupported
    }),
    [controller, summary, fence, permissionOwnSupported]
  )
  const takesSendOptions = useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY
  )

  const support =
    args.transportEnabled && conversationSupport?.sessionId === sessionId
      ? conversationSupport
      : null
  return {
    // What the picker shows and a send carries.
    optionView,
    controller,
    takesSelection,
    takesSendOptions,
    conversationSupport: support,
    sessionSupport: {
      acceptsImages: support?.acceptsImages,
      canSwitchAccount: support?.canSwitchAccount
    },
    rereadOptions,
    receiveCatalog,
    isCurrentContext,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    updateOptionState
  }
}
