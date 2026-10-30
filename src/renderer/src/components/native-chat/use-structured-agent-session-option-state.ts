import type { StructuredSessionConversationSupport } from './structured-agent-session-options-contract'
import {
  structuredSessionSelectionAuthority,
  structuredSessionSelectionController
} from '@/lib/structured-agent-session-selection-controller'
import { useStructuredSessionSelectionReads } from './use-structured-session-selection-reads'
import { projectRuntimePermission } from '../../../../shared/structured-agent-session-permission-option'
import { useStructuredAgentSessionStatusSummary } from './StructuredAgentSessionStatusBridge'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AgentSessionOptionsResult,
  AgentSessionModelCatalogResult
} from '../../../../shared/agent-session-wire'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import { usesInstalledAgentModelCatalog } from '../../../../shared/agent-model-catalog-ownership'
import { AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY } from '../../../../shared/structured-agent-session-surface-capabilities'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  settleStructuredAgentSessionBuiltinCatalog,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import {
  AGENT_SESSION_SEND_SELECTION_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY
} from '../../../../shared/agent-session-create-capabilities'
import {
  useStructuredAgentSessionHostCapability,
  useStructuredAgentSessionOwnPermissionState,
  structuredAgentSessionHostKey
} from '@/runtime/structured-agent-session-host-capability'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { cloneStructuredAgentSessionOptionRecord } from '../../../../shared/structured-agent-session-option-state'
import {
  createCoalescedPollRunner,
  type CoalescedPollRunner
} from '../right-sidebar/coalesced-poll-runner'

export { firstFrameOptionState } from './structured-agent-session-option-first-frame'
import { firstFrameOptionState } from './structured-agent-session-option-first-frame'

/** The picker's option state for one session: seeded, kept across its fences, re-read each turn. */
export function useStructuredAgentSessionOptionState(args: {
  agent: AgentType
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
  const [conversationSupport, setConversationSupport] =
    useState<StructuredSessionConversationSupport | null>(null)
  // A revision the loaded window dropped can move the host's whole-journal context facts.
  const contextRefresh = conversationSupport?.contextUsage ? (args.unloadedTurnRevisions ?? 0) : 0
  // Paint cached host evidence immediately; without it keep the placeholder until the host names the model.
  const [optionState, setOptionState] = useState(() =>
    firstFrameOptionState(agent, target, {
      newLaunch,
      seedsModel,
      ...(worktree ? { worktree } : {})
    })
  )
  // Read only when a fence or session resets the state, so a new target alone resets nothing.
  const firstFrameLaunch = useRef({ target, newLaunch, worktree, seedsModel })
  useEffect(() => {
    firstFrameLaunch.current = { target, newLaunch, worktree, seedsModel }
  }, [newLaunch, seedsModel, target, worktree])
  const optionStateRef = useRef(optionState)
  const activeOptionRecordRef = useRef(optionState.record)
  const authority = structuredSessionSelectionAuthority(target)
  const controller = structuredSessionSelectionController(target, sessionId, agent)
  const takesSelection = useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_SEND_SELECTION_RUNTIME_CAPABILITY
  )
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      setOptionState(next)
    },
    []
  )
  const hostKey = structuredAgentSessionHostKey(target)
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
  // A chat this view started names the default it runs until its first send pins it.
  const applyOptionsAnswer = useCallback(
    (current: StructuredAgentSessionOptionState, result: AgentSessionOptionsResult) =>
      optionCatalog
        ? applyStructuredAgentSessionOptions(current, optionCatalog, result, {
            newLaunch,
            coherentCatalog
          })
        : current,
    [newLaunch, optionCatalog, coherentCatalog]
  )
  const host = target.kind === 'local' ? 'local' : target.environmentId
  const optionIdentity = JSON.stringify([identity, host])
  const optionIdentityRef = useRef({ identity: optionIdentity, controller })
  useEffect(() => {
    const previous = optionStateRef.current
    const sameSession =
      optionIdentityRef.current.identity === optionIdentity &&
      optionIdentityRef.current.controller === controller
    optionIdentityRef.current = { identity: optionIdentity, controller }
    const launch = firstFrameLaunch.current
    const seeded = firstFrameOptionState(agent, launch.target, launch)
    // Retain saved picks/account listings across same-session restarts until the starting provider can be read.
    const kept =
      sameSession &&
      (previous.optionsAnswerPresent ||
        (previous.catalogSource !== 'seed' && previous.catalogSource !== null))
        ? {
            ...previous,
            record: cloneStructuredAgentSessionOptionRecord(previous.record),
            pendingId: null,
            reportedPermissionMode: undefined
          }
        : seeded
    const next = sameSession ? { ...kept, permissionMode: previous.permissionMode } : kept
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, fence, optionIdentity, contextKey, authority, controller])

  const readEpoch = useRef(0)
  const optionsReadRef = useRef<CoalescedPollRunner | null>(null)
  // Read each turn and after provider start to confirm the model the host actually runs.
  useEffect(() => {
    if (
      !providerVisible ||
      (providerStarting && !readsBeforeStart && !takesSelection) ||
      !optionCatalog
    ) {
      return
    }
    let stale = false
    const runner = createCoalescedPollRunner(async () => {
      if (!isCurrentContext()) {
        return
      }
      const epoch = readEpoch.current
      const record = activeOptionRecordRef.current
      const completed = controller.captureRead()
      const result = await controller.request((options) =>
        callStructuredAgentSession<AgentSessionOptionsResult>(
          target,
          'agentSession.options',
          { sessionId },
          options
        )
      )
      if (
        !stale &&
        isCurrentContext() &&
        readEpoch.current === epoch &&
        structuredSessionSelectionAuthority(target) === authority &&
        activeOptionRecordRef.current === record
      ) {
        setConversationSupport({
          sessionId,
          commands: result.conversationCommands ?? [],
          threadGoal: result.threadGoal,
          reportedThreadGoal: result.reportedThreadGoal,
          contextUsage: result.contextUsage,
          acceptsImages: result.acceptsImages,
          rewind: result.rewind ?? { supported: false, reason: 'unsupported' },
          fence
        })
        updateOptionState((current) =>
          current.record === record ? applyOptionsAnswer(current, result) : current
        )
        controller.retire(completed)
      }
    })
    optionsReadRef.current = runner
    runner.run()
    return () => {
      stale = true
      runner.dispose()
      optionsReadRef.current = null
    }
  }, [
    applyOptionsAnswer,
    isCurrentContext,
    authority,
    controller,
    takesSelection,
    fence,
    optionCatalog,
    providerStarting,
    providerVisible,
    readsBeforeStart,
    sessionId,
    target,
    updateOptionState
  ])

  // Options share the host queue with sends/interrupts; coalesce revision bursts into one active and one pending read.
  const seenContextRefresh = useRef(contextRefresh)
  useEffect(() => {
    if (contextRefresh !== seenContextRefresh.current) {
      seenContextRefresh.current = contextRefresh
      readEpoch.current += 1
      optionsReadRef.current?.run()
    }
  }, [contextRefresh])

  // An options answer made before the account's listing landed listed none of it.
  const rereadOptions = useCallback(() => {
    readEpoch.current += 1
    optionsReadRef.current?.run()
  }, [])
  useStructuredSessionSelectionReads({
    controller,
    target,
    authority,
    hostOptionStamp: args.hostOptionStamp,
    turnId: args.turnId,
    rereadOptions
  })
  const receiveCatalog = (
    catalog: AgentSessionModelCatalogResult | null,
    _event: 'demand' | 'progress' | 'settled'
  ) => {
    updateOptionState((current) =>
      catalog && optionCatalog
        ? applyStructuredAgentSessionModelCatalog(current, optionCatalog, catalog, {
            newLaunch,
            coherentCatalog
          })
        : settleStructuredAgentSessionBuiltinCatalog(current, false)
    )
    if (!coherentCatalog && catalog && catalog.origin !== 'unknown' && !catalog.listingInProgress) {
      rereadOptions()
    }
  }
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

  return {
    // What the picker shows and a send carries.
    optionView,
    controller,
    takesSelection,
    takesSendOptions,
    conversationSupport,
    rereadOptions,
    receiveCatalog,
    isCurrentContext,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    updateOptionState
  }
}
