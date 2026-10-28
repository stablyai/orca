import {
  createStructuredOptionPickBook,
  resetStructuredOptionPickBook,
  structuredOptionPickIsPending
} from '../../../../shared/structured-agent-session-option-pick-book'
import { projectRuntimePermission } from '../../../../shared/structured-agent-session-permission-option'
import { useStructuredAgentSessionStatusSummary } from './StructuredAgentSessionStatusBridge'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session/agent-session-conversation-command'
import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from '../../../../shared/agent-session-wire'
import type { AgentSessionRewindSupport } from '../../../../shared/agent-session-rewind'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { AgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import { usesInstalledAgentModelCatalog } from '../../../../shared/agent-model-catalog-ownership'
import { structuredAgentSessionSeedCatalog } from '../../../../shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionModelCatalog,
  applyStructuredAgentSessionOptions,
  settleStructuredAgentSessionBuiltinCatalog,
  createStructuredAgentSessionOptionState,
  type StructuredAgentSessionOptionState
} from '../../../../shared/structured-agent-session-options'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { structuredAgentSessionOptionView } from '../../../../shared/structured-agent-session-option-view'
import { AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY } from '../../../../shared/structured-agent-session-surface-capabilities'
import { AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import {
  useStructuredAgentSessionHostCapability,
  useStructuredAgentSessionOwnPermissionState,
  structuredAgentSessionHostKey
} from '@/runtime/structured-agent-session-host-capability'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { readHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { cloneStructuredAgentSessionOptionRecord } from '../../../../shared/structured-agent-session-option-state'
import {
  createCoalescedPollRunner,
  type CoalescedPollRunner
} from '../right-sidebar/coalesced-poll-runner'

/** Use the cached host list on first paint, otherwise a quiet seed placeholder until the host answers. */
export function firstFrameOptionState(
  agent: AgentType,
  target: RuntimeClientTarget,
  launch: { newLaunch: boolean; worktree?: string; seedsModel: boolean }
): StructuredAgentSessionOptionState {
  const seed = structuredAgentSessionSeedCatalog(agent)
  const seeded = createStructuredAgentSessionOptionState(agent, seed)
  const snapshot = readHostModelCatalogSnapshot(target, agent, launch)
  return snapshot ? applyStructuredAgentSessionModelCatalog(seeded, seed, snapshot, launch) : seeded
}

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
    hostOptionStamp,
    identity,
    newLaunch,
    optionCatalog,
    seedsModel,
    providerStarting,
    providerVisible,
    readsBeforeStart,
    sessionId,
    target,
    turnId,
    worktree
  } = args
  const { summary, observation } = useStructuredAgentSessionStatusSummary(sessionId, target)
  const [conversationSupport, setConversationSupport] = useState<{
    sessionId: string
    commands: readonly AgentSessionConversationCommand[]
    threadGoal: AgentSessionOptionsResult['threadGoal']
    reportedThreadGoal: AgentSessionOptionsResult['reportedThreadGoal']
    contextUsage: AgentSessionOptionsResult['contextUsage']
    acceptsImages: boolean | undefined
    rewind: AgentSessionRewindSupport
    /** The fence the read answered for; rewind support is only that runtime's. */
    fence: number | null
  } | null>(null)
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
  }, [target, newLaunch, worktree, seedsModel])
  const optionStateRef = useRef(optionState)
  const activeOptionRecordRef = useRef(optionState.record)
  // Picks on their way to the host, which every send carries too.
  const optionPicks = useRef(createStructuredOptionPickBook())
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
  const writes = useRef({ count: 0, readback: false })
  const coherentCatalog = usesInstalledAgentModelCatalog(
    agent,
    useStructuredAgentSessionHostCapability(target, AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY)
  )
  const optionIdentityRef = useRef(identity)
  useEffect(() => {
    const previous = optionStateRef.current
    const sameSession = optionIdentityRef.current === identity
    optionIdentityRef.current = identity
    const launch = firstFrameLaunch.current
    const seeded = firstFrameOptionState(agent, launch.target, launch)
    // Retain saved picks/account listings across same-session restarts until the starting provider can be read.
    const kept =
      sameSession && previous.catalogSource !== 'seed' && previous.catalogSource !== null
        ? {
            ...previous,
            catalogSource: 'host' as const,
            record: cloneStructuredAgentSessionOptionRecord(previous.record),
            pendingId: null,
            reportedPermissionMode: undefined
          }
        : seeded
    const next = sameSession ? { ...kept, permissionMode: previous.permissionMode } : kept
    writes.current = { count: 0, readback: false }
    resetStructuredOptionPickBook(optionPicks.current)
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, contextKey, fence, identity])

  const optionsReadRef = useRef<CoalescedPollRunner | null>(null)
  // Read each turn and after provider start to confirm the model the host actually runs.
  useEffect(() => {
    if (!providerVisible || (providerStarting && !readsBeforeStart) || !optionCatalog) {
      return
    }
    let stale = false
    const runner = createCoalescedPollRunner(async () => {
      if (!isCurrentContext()) {
        return
      }
      if (writes.current.count) {
        writes.current.readback = true
        return
      }
      writes.current.readback = false
      const record = activeOptionRecordRef.current
      const readGeneration = optionPicks.current.generation
      const result = await callStructuredAgentSession<AgentSessionOptionsResult>(
        target,
        'agentSession.options',
        { sessionId }
      )
      if (
        !stale &&
        isCurrentContext() &&
        activeOptionRecordRef.current === record &&
        optionPicks.current.generation === readGeneration
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
          current.record === activeOptionRecordRef.current
            ? applyStructuredAgentSessionOptions(current, optionCatalog, result, {
                newLaunch,
                coherentCatalog
              })
            : current
        )
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
    newLaunch,
    isCurrentContext,
    coherentCatalog,
    fence,
    optionCatalog,
    hostOptionStamp,
    providerStarting,
    providerVisible,
    readsBeforeStart,
    sessionId,
    target,
    turnId,
    updateOptionState
  ])

  // Options share the host queue with sends/interrupts; coalesce revision bursts into one active and one pending read.
  const seenContextRefresh = useRef(contextRefresh)
  useEffect(() => {
    if (contextRefresh !== seenContextRefresh.current) {
      seenContextRefresh.current = contextRefresh
      optionsReadRef.current?.run()
    }
  }, [contextRefresh])

  // An options read predating the account listing needs a fresh catalog-aware answer.
  const rereadOptions = useCallback(() => optionsReadRef.current?.run(), [])
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
  const beginOptionWrite = (_id: string) => {
    const record = activeOptionRecordRef.current
    writes.current.count += 1
    return (readback: boolean) => {
      if (!isCurrentContext() || activeOptionRecordRef.current !== record) {
        return
      }
      writes.current.count -= 1
      writes.current.readback ||= readback
      if (!writes.current.count && writes.current.readback) {
        rereadOptions()
      }
    }
  }
  const permissionOwnSupport = useStructuredAgentSessionOwnPermissionState(target)
  const permissionOwnSupported =
    permissionOwnSupport === 'unknown' ? null : permissionOwnSupport === 'supported'
  const takesSendOptions = useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY
  )

  return {
    // What the picker shows and a send carries.
    optionView: (
      ...args: Parameters<typeof structuredAgentSessionOptionView>
    ): StructuredAgentSessionOptionState => {
      const view = {
        ...projectRuntimePermission(structuredAgentSessionOptionView(...args), summary, fence),
        permissionOwnSupported
      }
      return structuredOptionPickIsPending(optionPicks.current, 'model')
        ? { ...view, pendingId: 'model' }
        : view
    },
    takesSendOptions,
    conversationSupport,
    receiveCatalog,
    beginOptionWrite,
    isCurrentContext,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    optionPicks,
    updateOptionState
  }
}
