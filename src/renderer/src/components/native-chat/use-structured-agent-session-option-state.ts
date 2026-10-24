import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentSessionConversationCommand } from '../../../../shared/agent-session-conversation-command'
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
  structuredAgentSessionHostKey
} from '@/runtime/structured-agent-session-host-capability'
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import { readHostModelCatalogSnapshot } from '@/runtime/host-model-catalog-snapshots'
import { cloneStructuredAgentSessionOptionRecord } from '../../../../shared/structured-agent-session-option-state'
import {
  createCoalescedPollRunner,
  type CoalescedPollRunner
} from '../right-sidebar/coalesced-poll-runner'

/** The first frame: the host's saved list when the renderer already holds it, else the seed,
 *  which shows the quiet placeholder until the host answers. */
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
  /** Whether this is a new chat, where it runs and whether it names its model: what the
   *  host's saved list is read for. */
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
  // The first frame is the final one when the renderer holds the host's list; otherwise the quiet
  // placeholder stands until the host answers, never a built-in label the host may replace.
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
  // A pick on its way to the host, which every send carries too.
  const pendingOptionsRef = useRef<Record<string, string>>({})
  const optionMutationGeneration = useRef(0)
  const updateOptionState = useCallback(
    (update: (current: StructuredAgentSessionOptionState) => StructuredAgentSessionOptionState) => {
      const next = update(optionStateRef.current)
      optionStateRef.current = next
      setOptionState(next)
    },
    []
  )
  const hostKey = structuredAgentSessionHostKey(target)
  const contextKey = JSON.stringify([identity, hostKey, newLaunch, worktree, fence])
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
    // The chat's next runtime starts with the picks the host saved, which this view last showed,
    // and a starting agent is not read: keep them, and the account's list, until a read replaces them.
    const kept =
      sameSession && previous.catalogSource !== 'seed' && previous.catalogSource !== null
        ? {
            ...previous,
            catalogSource: 'host' as const,
            record: cloneStructuredAgentSessionOptionRecord(previous.record),
            pendingId: null
          }
        : seeded
    // The chat's own, which a restart for a new mode keeps: the picker never blanks between them.
    const next = sameSession ? { ...kept, permissionMode: previous.permissionMode } : kept
    writes.current = { count: 0, readback: false }
    optionMutationGeneration.current += 1
    pendingOptionsRef.current = {}
    optionStateRef.current = next
    activeOptionRecordRef.current = next.record
    setOptionState(next)
  }, [agent, contextKey, fence, identity])

  const optionsReadRef = useRef<CoalescedPollRunner | null>(null)
  // Refresh options each turn to confirm which model the provider actually selected, and once
  // the provider starts: only then has the host read what it will run.
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
      const readGeneration = optionMutationGeneration.current
      const result = await callStructuredAgentSession<AgentSessionOptionsResult>(
        target,
        'agentSession.options',
        { sessionId }
      )
      if (
        !stale &&
        isCurrentContext() &&
        activeOptionRecordRef.current === record &&
        optionMutationGeneration.current === readGeneration
      ) {
        setConversationSupport({
          sessionId,
          commands: result.conversationCommands ?? [],
          threadGoal: result.threadGoal,
          reportedThreadGoal: result.reportedThreadGoal,
          contextUsage: result.contextUsage,
          acceptsImages: result.acceptsImages,
          // A host that predates rewind does not name it.
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
    // Another device's pick moves it.
    hostOptionStamp,
    providerStarting,
    providerVisible,
    readsBeforeStart,
    sessionId,
    target,
    turnId,
    updateOptionState
  ])

  // Reads share the session's host queue with sends and interrupts, so a burst of
  // missed revisions keeps one read in flight and at most one behind it.
  const seenContextRefresh = useRef(contextRefresh)
  useEffect(() => {
    if (contextRefresh !== seenContextRefresh.current) {
      seenContextRefresh.current = contextRefresh
      optionsReadRef.current?.run()
    }
  }, [contextRefresh])

  // An options answer made before the account's listing landed listed none of it.
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
  const takesSendOptions = useStructuredAgentSessionHostCapability(
    target,
    AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY
  )

  return {
    // What the picker shows and a send carries.
    optionView: (...args: Parameters<typeof structuredAgentSessionOptionView>) => {
      const view = structuredAgentSessionOptionView(...args)
      return pendingOptionsRef.current.model === undefined ? view : { ...view, pendingId: 'model' }
    },
    takesSendOptions,
    conversationSupport,
    receiveCatalog,
    beginOptionWrite,
    isCurrentContext,
    optionState,
    optionStateRef,
    activeOptionRecordRef,
    pendingOptionsRef,
    optionMutationGeneration,
    updateOptionState
  }
}
