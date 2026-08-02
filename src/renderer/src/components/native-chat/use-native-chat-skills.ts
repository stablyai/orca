import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../shared/skills'
import { getNativeChatAgentProfile } from '../../../../shared/native-chat-agent-profiles'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { emitNativeChatSkillDiscovery } from '@/lib/native-chat-telemetry'
import {
  resolveNativeChatSkillDiscoveryContext,
  selectNativeChatSkillStateInputs,
  type NativeChatSkillDiscoveryContext
} from './native-chat-skill-discovery-context'

export {
  resolveNativeChatSkillDiscoveryContext,
  resolveNativeChatSkillDiscoveryCwd
} from './native-chat-skill-discovery-context'

// The host scan budget honored by runtime targets that respect timeoutMs.
const DISCOVERY_TIMEOUT_MS = 10_000
// Renderer wall-clock backstop for the local branch (which ignores timeoutMs).
// It must exceed the host's summed worst case — a WSL scan runs a metadata read
// (5s) then the tree walk (10s) in sequence — so the host's own precise timeout
// wins and a WSL cold boot does not surface a healthy scan as a spurious timeout.
const DISCOVERY_BACKSTOP_TIMEOUT_MS = 18_000

export type NativeChatSkillDiscovery = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  skills: DiscoveredSkill[]
  error: Error | null
  errorKind?: 'unavailable' | 'timeout' | 'host' | 'unknown'
  retry: () => void
}

type StoredDiscoveryState = Omit<NativeChatSkillDiscovery, 'retry'> & {
  contextKey: string | null
}

const IDLE_STATE: StoredDiscoveryState = {
  status: 'idle',
  skills: [],
  error: null,
  contextKey: null
}
const inFlightDiscovery = new Map<string, Promise<SkillDiscoveryResult>>()

export function isNativeChatSkillForAgent(
  agent: AgentType,
  skill: DiscoveredSkill,
  result?: Pick<SkillDiscoveryResult, 'sources'>
): boolean {
  const profile = getNativeChatAgentProfile(agent)
  if (!profile) {
    return false
  }
  if (!result) {
    return (
      agent === 'codex' &&
      (skill.providers.includes('codex') || skill.providers.includes('agent-skills'))
    )
  }
  // Why: canonical-path dedup keeps one row per file, but a symlinked skill can
  // be reachable through several roots; any shared or agent-owned root grants
  // visibility regardless of which root the scanner happened to list first.
  const rootPaths = skill.rootPaths?.length ? skill.rootPaths : [skill.rootPath]
  return rootPaths.some((rootPath) => {
    const source = result.sources.find((entry) => entry.path === rootPath)
    return source?.owner === null || source?.owner === profile.skillSourceOwner
  })
}

export function useNativeChatSkills(
  agent: AgentType,
  terminalTabId: string,
  enabled = false
): NativeChatSkillDiscovery {
  const inputs = useAppStore(useShallow(selectNativeChatSkillStateInputs))
  const context = useMemo(
    () => resolveNativeChatSkillDiscoveryContext(inputs, terminalTabId),
    [inputs, terminalTabId]
  )
  const [state, setState] = useState<StoredDiscoveryState>(IDLE_STATE)
  const [retryGeneration, setRetryGeneration] = useState(0)
  const paneDiscoveryCache = useRef(new Map<string, SkillDiscoveryResult>())
  const profile = getNativeChatAgentProfile(agent)

  useEffect(() => {
    let cancelled = false
    if (!profile || !enabled || !context) {
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
    if (cached) {
      emitNativeChatSkillDiscovery({
        agent,
        outcome: 'ready',
        executionHostKind: context.executionHostKind
      })
      setState({ status: 'ready', skills: cached.skills, error: null, contextKey: context.key })
      return
    }
    setState({ status: 'loading', skills: [], error: null, contextKey: context.key })
    const request = getOrStartDiscovery(context)
    void request.then(
      (result) => {
        paneDiscoveryCache.current.set(paneCacheKey, result)
        if (cancelled) {
          return
        }
        emitNativeChatSkillDiscovery({
          agent,
          outcome: 'ready',
          executionHostKind: context.executionHostKind
        })
        setState({ status: 'ready', skills: result.skills, error: null, contextKey: paneCacheKey })
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
      !profile || !enabled || !context
        ? IDLE_STATE
        : state.contextKey === context.key
          ? state
          : { status: 'loading' as const, skills: [], error: null, contextKey: context.key },
    [context, enabled, profile, state]
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

  const retry = useCallback(() => {
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
      error: effectiveState.error,
      ...(effectiveState.errorKind ? { errorKind: effectiveState.errorKind } : {}),
      retry
    }),
    [effectiveState, retry, visibleSkills]
  )
}

function getOrStartDiscovery(
  context: NativeChatSkillDiscoveryContext
): Promise<SkillDiscoveryResult> {
  const existing = inFlightDiscovery.get(context.key)
  if (existing) {
    return existing
  }
  // Why: the local runtime.call branch ignores timeoutMs, so the renderer must
  // enforce the design's scan timeout itself or a stalled local scan loads forever.
  const request = withDiscoveryTimeout(
    callRuntimeRpc<SkillDiscoveryResult>(
      context.runtimeTarget,
      'skills.discover',
      context.discoveryTarget,
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
