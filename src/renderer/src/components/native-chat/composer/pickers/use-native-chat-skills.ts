import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../../../store/index'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../../../shared/skills'
import type { DiscoveredSlashCommand } from '../../../../../../shared/custom-slash-commands'
import { getNativeChatAgentProfile } from '../../../../../../shared/native-chat/native-chat-agent-profiles'
import { isNativeChatSkillForAgent } from '../../../../../../shared/native-chat/input/native-chat-skill-visibility'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { emitNativeChatSkillDiscovery } from '@/components/native-chat/telemetry/native-chat-telemetry'
import {
  isNativeChatSkillDiscoveryAwaitingDirectory,
  resolveNativeChatSkillDiscoveryContext,
  selectNativeChatSkillStateInputs,
  type NativeChatSkillDiscoveryContext
} from './native-chat-skill-discovery-context'

// The host scan budget honored by runtime targets that respect timeoutMs.
const DISCOVERY_TIMEOUT_MS = 10_000
// Exceed WSL’s sequential metadata (5s) and walk (10s) budgets so host timeouts win over the local backstop.
const DISCOVERY_BACKSTOP_TIMEOUT_MS = 18_000

export type NativeChatSkillDiscovery = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  skills: DiscoveredSkill[]
  /** `.claude/commands` entries from the same scan; empty for non-Claude agents. */
  commands: readonly DiscoveredSlashCommand[]
  error: Error | null
  errorKind?: 'unavailable' | 'timeout' | 'host' | 'unknown'
  retry: () => void
}

type StoredDiscoveryState = Omit<NativeChatSkillDiscovery, 'retry' | 'commands'> & {
  contextKey: string | null
  commands?: readonly DiscoveredSlashCommand[] | undefined
}

const NO_COMMANDS: readonly DiscoveredSlashCommand[] = []

const IDLE_STATE: StoredDiscoveryState = {
  status: 'idle',
  skills: [],
  error: null,
  contextKey: null
}
// No context yet, but one is on its way: reads as loading rather than as a failed scan.
const AWAITING_CONTEXT_STATE: StoredDiscoveryState = {
  status: 'loading',
  skills: [],
  error: null,
  contextKey: null
}
const MISSING_CONTEXT_STATE: StoredDiscoveryState = {
  status: 'error',
  skills: [],
  error: new Error('Skill discovery context is unavailable.'),
  errorKind: 'unknown',
  contextKey: null
}
const selectNoSkillStateInputs = (): null => null
const inFlightDiscovery = new Map<string, Promise<SkillDiscoveryResult>>()

export function useNativeChatSkills(
  agent: AgentType,
  terminalTabId: string,
  enabled = false,
  launchWorktreeId?: string
): NativeChatSkillDiscovery {
  // Closed is the common state, so the tab-map subscription only runs while the picker is open.
  const inputs = useAppStore(
    useShallow(enabled ? selectNativeChatSkillStateInputs : selectNoSkillStateInputs)
  )
  const context = useMemo(
    () =>
      inputs
        ? resolveNativeChatSkillDiscoveryContext(inputs, terminalTabId, launchWorktreeId)
        : null,
    [inputs, terminalTabId, launchWorktreeId]
  )
  const awaitingContext = useMemo(
    () =>
      inputs !== null &&
      !context &&
      isNativeChatSkillDiscoveryAwaitingDirectory(inputs, terminalTabId),
    [context, inputs, terminalTabId]
  )
  const [state, setState] = useState<StoredDiscoveryState>(IDLE_STATE)
  const [retryGeneration, setRetryGeneration] = useState(0)
  // Last answer per pane, shown at once on reopen while the host is asked again.
  const paneDiscoveryCache = useRef(new Map<string, SkillDiscoveryResult>())
  // Panes already asked during this open; store churn re-runs the effect and must not re-query.
  const checkedThisOpen = useRef(new Set<string>())
  // Consume retry intent once; a generation-wide force flag would leak across pane switches.
  const forceNextDiscovery = useRef(false)
  const profile = getNativeChatAgentProfile(agent)

  useEffect(() => {
    let cancelled = false
    if (!profile || !enabled || !context) {
      // Without a current pane, discard retry intent before it can force another pane’s scan.
      forceNextDiscovery.current = false
      // The next open asks the host again so skills installed meanwhile appear.
      checkedThisOpen.current.clear()
      setState(IDLE_STATE)
      return
    }
    if (context.executionHostKind === 'ssh') {
      emitNativeChatSkillDiscovery({
        agent,
        outcome: 'unavailable',
        executionHostKind: 'ssh'
      })
      setState({
        status: 'error',
        skills: [],
        error: new Error('Skill discovery is unavailable for SSH hosts.'),
        errorKind: 'unavailable',
        contextKey: context.key
      })
      return
    }

    const paneCacheKey = context.key
    const cached = paneDiscoveryCache.current.get(paneCacheKey)
    setState(
      cached
        ? {
            status: 'ready',
            skills: cached.skills,
            commands: cached.commands,
            error: null,
            contextKey: context.key
          }
        : { status: 'loading', skills: [], error: null, contextKey: context.key }
    )
    if (cached && checkedThisOpen.current.has(paneCacheKey)) {
      emitNativeChatSkillDiscovery({
        agent,
        outcome: 'ready',
        executionHostKind: context.executionHostKind
      })
      return
    }
    // Explicit Retry bypasses shared host scans; passive discovery reuses them.
    const forced = forceNextDiscovery.current
    forceNextDiscovery.current = false
    const request = getOrStartDiscovery(context, forced)
    void request.then(
      (result) => {
        paneDiscoveryCache.current.set(paneCacheKey, result)
        // A scan that settles after close still seeds the next open but must not count as its check.
        if (cancelled) {
          return
        }
        checkedThisOpen.current.add(paneCacheKey)
        emitNativeChatSkillDiscovery({
          agent,
          outcome: 'ready',
          executionHostKind: context.executionHostKind
        })
        setState({
          status: 'ready',
          skills: result.skills,
          commands: result.commands,
          error: null,
          contextKey: paneCacheKey
        })
      },
      (reason) => {
        if (cancelled) {
          return
        }
        const error = reason instanceof Error ? reason : new Error(String(reason))
        const timedOut = /timed?\s*out|timeout/i.test(error.message)
        emitNativeChatSkillDiscovery({
          agent,
          outcome: timedOut ? 'timeout' : 'error',
          executionHostKind: context.executionHostKind
        })
        checkedThisOpen.current.add(paneCacheKey)
        if (cached) {
          // A failed recheck keeps the last good list rather than hiding it behind an error.
          return
        }
        setState({
          status: 'error',
          skills: [],
          error,
          errorKind: timedOut
            ? 'timeout'
            : context.executionHostKind === 'runtime'
              ? 'host'
              : 'unknown',
          contextKey: paneCacheKey
        })
      }
    )
    return () => {
      cancelled = true
    }
  }, [agent, context, enabled, profile, retryGeneration])

  const effectiveState = useMemo(
    () =>
      !profile || !enabled
        ? IDLE_STATE
        : !context
          ? awaitingContext
            ? AWAITING_CONTEXT_STATE
            : MISSING_CONTEXT_STATE
          : state.contextKey === context.key
            ? state
            : { status: 'loading' as const, skills: [], error: null, contextKey: context.key },
    [awaitingContext, context, enabled, profile, state]
  )
  const visibleSkills = useMemo(() => {
    if (!profile || effectiveState.status !== 'ready') {
      return []
    }
    const result = context ? paneDiscoveryCache.current.get(context.key) : undefined
    return result
      ? effectiveState.skills.filter((skill) => isNativeChatSkillForAgent(agent, skill, result))
      : []
  }, [agent, context, effectiveState, profile])

  // `.claude/commands` is Claude Code grammar; other TUIs would reject the inserted token.
  const visibleCommands =
    profile?.skillSourceOwner === 'claude' && effectiveState.status === 'ready'
      ? (effectiveState.commands ?? NO_COMMANDS)
      : NO_COMMANDS

  const retry = useCallback(() => {
    forceNextDiscovery.current = true
    if (context) {
      paneDiscoveryCache.current.delete(context.key)
      setState({ status: 'loading', skills: [], error: null, contextKey: context.key })
    }
    setRetryGeneration((generation) => generation + 1)
  }, [context])
  return useMemo(
    () => ({
      status: effectiveState.status,
      skills: visibleSkills,
      commands: visibleCommands,
      error: effectiveState.error,
      ...(effectiveState.errorKind ? { errorKind: effectiveState.errorKind } : {}),
      retry
    }),
    [effectiveState, retry, visibleCommands, visibleSkills]
  )
}

function getOrStartDiscovery(
  context: NativeChatSkillDiscoveryContext,
  refresh = false
): Promise<SkillDiscoveryResult> {
  const existing = inFlightDiscovery.get(context.key)
  if (existing && !refresh) {
    return existing
  }
  // Local runtime.call ignores timeoutMs; enforce a renderer deadline so stalled scans cannot load forever.
  const request = withDiscoveryTimeout(
    callRuntimeRpc<SkillDiscoveryResult>(
      context.runtimeTarget,
      'skills.discover',
      refresh ? { ...context.discoveryTarget, refresh: true } : context.discoveryTarget,
      {
        timeoutMs: DISCOVERY_TIMEOUT_MS
      }
    ),
    DISCOVERY_BACKSTOP_TIMEOUT_MS
  ).finally(() => {
    if (inFlightDiscovery.get(context.key) === request) {
      inFlightDiscovery.delete(context.key)
    }
  })
  inFlightDiscovery.set(context.key, request)
  return request
}

function withDiscoveryTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Skill discovery timed out.')), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (reason) => {
        clearTimeout(timer)
        reject(reason)
      }
    )
  })
}

export function resetNativeChatSkillDiscoveryCacheForTests(): void {
  inFlightDiscovery.clear()
}
