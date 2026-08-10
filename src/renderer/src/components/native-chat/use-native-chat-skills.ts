import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type {
  DiscoveredSkill,
  SkillDiscoveryForPaneResponse,
  SkillDiscoveryResult
} from '../../../../shared/skills'
import { getNativeChatAgentProfile } from '../../../../shared/native-chat-agent-profiles'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { isRuntimeCompatBlockError } from '@/runtime/runtime-protocol-compat'
import { emitNativeChatSkillDiscovery } from '@/lib/native-chat-telemetry'
import {
  resolveNativeChatSkillDiscoverySubscriptionKey,
  resolveSubscribedNativeChatSkillDiscoveryContext,
  type NativeChatSkillDiscoveryContext
} from './native-chat-skill-discovery-context'
import type { NativeChatSkillDiscoveryErrorKind } from './native-chat-picker-items'
import { readPaneDiscoveryCache, writePaneDiscoveryCache } from './native-chat-pane-discovery-cache'

export {
  resolveNativeChatSkillDiscoveryContext,
  resolveNativeChatSkillDiscoveryCwd
} from './native-chat-skill-discovery-context'

const DISCOVERY_TIMEOUT_MS = 10_000
const RUNTIME_DISCOVERY_TIMEOUT_MS = 18_000
const LOCAL_DISCOVERY_BACKSTOP_MS = 18_000
const PAIRED_SSH_DISCOVERY_BACKSTOP_MS = 22_000
// Runtime backstops include the compatibility probe that precedes the host scan.
const RUNTIME_DISCOVERY_BACKSTOP_MS = 38_000

export type NativeChatSkillDiscovery = {
  status: 'idle' | 'loading' | 'ready' | 'error'
  skills: DiscoveredSkill[]
  error: Error | null
  errorKind?: NativeChatSkillDiscoveryErrorKind
  retry: () => void
}

/** Old relay behind a current runtime; reconnecting the SSH host deploys it. */
class SshRelaySkillUpgradeRequiredError extends Error {
  constructor() {
    super('This SSH host is running an older Orca relay without skill discovery.')
    this.name = 'SshRelaySkillUpgradeRequiredError'
  }
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
  const contextSubscriptionKey = useAppStore((state) =>
    resolveNativeChatSkillDiscoverySubscriptionKey(state, terminalTabId, enabled)
  )
  const context = useMemo(
    () =>
      resolveSubscribedNativeChatSkillDiscoveryContext(
        useAppStore.getState(),
        terminalTabId,
        enabled,
        contextSubscriptionKey
      ),
    [contextSubscriptionKey, enabled, terminalTabId]
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
    if (context.executionHostKind === 'ssh' && context.sshDisconnected) {
      emitNativeChatSkillDiscovery({
        agent,
        outcome: 'error',
        executionHostKind: 'ssh'
      })
      setState({
        status: 'error',
        skills: [],
        error: new Error('The SSH host is disconnected.'),
        errorKind: 'host',
        contextKey: context.key
      })
      return
    }

    const paneCacheKey = context.key
    const cached = readPaneDiscoveryCache(paneDiscoveryCache.current, paneCacheKey)
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
        if (cancelled) {
          return
        }
        writePaneDiscoveryCache(paneDiscoveryCache.current, paneCacheKey, result)
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
        const upgradeKind = classifyUpgradeRequired(context, error)
        const timedOut = !upgradeKind && /timed?\s*out|timeout/i.test(error.message)
        emitNativeChatSkillDiscovery({
          agent,
          outcome: upgradeKind ? 'upgrade-required' : timedOut ? 'timeout' : 'error',
          executionHostKind: context.executionHostKind
        })
        setState({
          status: 'error',
          skills: [],
          error,
          errorKind:
            upgradeKind ??
            (timedOut
              ? 'timeout'
              : context.executionHostKind === 'runtime' || context.executionHostKind === 'ssh'
                ? 'host'
                : 'unknown'),
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
    startDiscoveryRequest(context),
    discoveryBackstopTimeoutMs(context)
  ).finally(() => {
    if (inFlightDiscovery.get(context.key) === request) {
      inFlightDiscovery.delete(context.key)
    }
  })
  inFlightDiscovery.set(context.key, request)
  return request
}

async function startDiscoveryRequest(
  context: NativeChatSkillDiscoveryContext
): Promise<SkillDiscoveryResult> {
  const timeoutMs =
    context.executionHostKind === 'runtime' ? RUNTIME_DISCOVERY_TIMEOUT_MS : DISCOVERY_TIMEOUT_MS
  if (context.executionHostKind === 'ssh') {
    const response = await callRuntimeRpc<SkillDiscoveryForPaneResponse>(
      context.runtimeTarget,
      'skills.discoverForPane',
      context.paneTarget,
      { timeoutMs }
    )
    if (response.status === 'relay-upgrade-required') {
      throw new SshRelaySkillUpgradeRequiredError()
    }
    return response.result
  }
  return callRuntimeRpc<SkillDiscoveryResult>(
    context.runtimeTarget,
    'skills.discover',
    context.discoveryTarget,
    { timeoutMs }
  )
}

function discoveryBackstopTimeoutMs(context: NativeChatSkillDiscoveryContext): number {
  if (context.executionHostKind === 'runtime') {
    return RUNTIME_DISCOVERY_BACKSTOP_MS
  }
  return context.executionHostKind === 'ssh' && context.runtimeTarget.kind === 'environment'
    ? PAIRED_SSH_DISCOVERY_BACKSTOP_MS
    : LOCAL_DISCOVERY_BACKSTOP_MS
}

function classifyUpgradeRequired(
  context: NativeChatSkillDiscoveryContext,
  error: Error
): Extract<
  NativeChatSkillDiscoveryErrorKind,
  'relay-upgrade-required' | 'runtime-upgrade-required'
> | null {
  if (context.executionHostKind !== 'ssh') {
    return null
  }
  if (error instanceof SshRelaySkillUpgradeRequiredError) {
    return 'relay-upgrade-required'
  }
  // Why: a runtime predating skills.discoverForPane would strip pane identity
  // from the legacy method and scan its own disk; the missing method is the
  // detectable version-skew signal (same mapping as native chat history).
  if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
    return 'runtime-upgrade-required'
  }
  if (isRuntimeCompatBlockError(error)) {
    return 'runtime-upgrade-required'
  }
  return null
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
