// Live slash-command catalog for OMP panes. Reads the main-process RPC probe
// once per (pane cwd) and merges the result over the static catalog; every
// failure path silently keeps today's static commands, because an unreachable
// probe must never empty the composer's `/` menu. On an RPC-owned pane the
// owning session's own published catalog outranks that probe snapshot — see
// selectOmpRpcLiveCommands.

import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { OmpRpcSlashCommand } from '../../../../shared/omp-rpc-protocol'
import type { SlashCommandSuggestion } from '../../../../shared/native-chat-slash-commands'
import {
  resolveNativeChatSkillDiscoveryContext,
  type NativeChatSkillDiscoveryContext,
  selectNativeChatSkillStateInputs
} from './native-chat-skill-discovery-context'
import {
  isOmpRpcCatalogAgent,
  mergeOmpRpcCommands,
  selectOmpRpcLiveCommands
} from './omp-rpc-command-catalog'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { structuredSlashCommands } from '../../../../shared/structured-agent-session-composer'

// Re-exported: the predicate lives in the catalog module so the pure routing
// modules can ask it without pulling this hook's store dependency in with it.
export { isOmpRpcCatalogAgent }

export function canUseLocalOmpRpcProbe(context: NativeChatSkillDiscoveryContext | null): boolean {
  return (
    context?.executionHostKind === 'local' &&
    !(
      context.discoveryTarget.projectRuntime?.status === 'resolved' &&
      context.discoveryTarget.projectRuntime.runtime.kind === 'wsl'
    )
  )
}

// Shared across panes: two OMP panes in one workspace ask the same probe.
const catalogCache = new Map<string, OmpRpcSlashCommand[]>()
const inFlight = new Map<string, Promise<OmpRpcSlashCommand[] | null>>()

/** The pane's working directory, which keys the probe. Null for non-OMP panes,
 *  panes with no resolved agent yet, and panes whose workspace cannot be
 *  resolved — all three mean "no RPC". */
export function useOmpRpcProbeCwd(agent: AgentType | null, terminalTabId: string): string | null {
  const inputs = useAppStore(useShallow(selectNativeChatSkillStateInputs))
  const enabled = isOmpRpcCatalogAgent(agent)
  return useMemo(() => {
    if (!enabled) {
      return null
    }
    const context = resolveNativeChatSkillDiscoveryContext(inputs, terminalTabId)
    // This IPC pool owns client-local children only. A remote runtime, SSH,
    // or WSL pane must retain its terminal route until that host exposes its
    // own RPC surface; a same-named local cwd is not an acceptable fallback.
    if (!canUseLocalOmpRpcProbe(context)) {
      return null
    }
    return context?.cwd ?? null
  }, [enabled, inputs, terminalTabId])
}

/** `sessionCommands` is the catalog the RPC child owning this pane published;
 *  it outranks the probe snapshot (see `selectOmpRpcLiveCommands`). Optional so
 *  a pane with no RPC session keeps calling this exactly as before. */
export function useOmpRpcCommands(
  agent: AgentType,
  terminalTabId: string,
  staticCommands: readonly SlashCommandSuggestion[],
  sessionCommands?: readonly OmpRpcSlashCommand[] | null
): readonly SlashCommandSuggestion[] {
  const enabled = isOmpRpcCatalogAgent(agent)
  const cwd = useOmpRpcProbeCwd(agent, terminalTabId)
  const [live, setLive] = useState<OmpRpcSlashCommand[] | null>(() =>
    cwd ? (catalogCache.get(cwd) ?? null) : null
  )

  useEffect(() => {
    if (!cwd) {
      setLive(null)
      return
    }
    const cached = catalogCache.get(cwd)
    if (cached) {
      setLive(cached)
      return
    }
    let cancelled = false
    void loadOmpRpcCommands(cwd).then((commands) => {
      if (!cancelled) {
        setLive(commands)
      }
    })
    return () => {
      cancelled = true
    }
  }, [cwd])

  return useMemo(
    () =>
      enabled
        ? mergeOmpRpcCommands(staticCommands, selectOmpRpcLiveCommands(sessionCommands, live))
        : staticCommands,
    [enabled, live, sessionCommands, staticCommands]
  )
}

function loadOmpRpcCommands(cwd: string): Promise<OmpRpcSlashCommand[] | null> {
  const existing = inFlight.get(cwd)
  if (existing) {
    return existing
  }
  const request = Promise.resolve()
    .then(() => window.api?.ompRpc?.getCommands({ cwd }))
    .then((result) => {
      if (!result?.ok) {
        return null
      }
      catalogCache.set(cwd, result.commands)
      return result.commands
    })
    // Why: a missing handler or a dead probe is a fallback, not an error the
    // composer surfaces — the static catalog already answers the `/` menu.
    .catch(() => null)
    .finally(() => {
      if (inFlight.get(cwd) === request) {
        inFlight.delete(cwd)
      }
    })
  inFlight.set(cwd, request)
  return request
}

export function resetOmpRpcCommandCacheForTests(): void {
  catalogCache.clear()
  inFlight.clear()
}

/** The composer's whole command surface in one call: the static per-agent (or
 *  structured-session) catalog, the live OMP catalog merged over it, and the
 *  probe cwd the local-command route needs. Grouped here because all three
 *  answer the same question from the same inputs, and the composer is at its
 *  line ratchet. */
export function useNativeChatComposerCommands(args: {
  agent: AgentType
  terminalTabId: string
  structured: boolean
  sessionCommands?: readonly OmpRpcSlashCommand[] | null
}): { agentCommands: readonly SlashCommandSuggestion[]; ompRpcCwd: string | null } {
  const { agent, terminalTabId, structured, sessionCommands } = args
  const staticAgentCommands = useMemo(
    () => (structured ? structuredSlashCommands(agent) : getVerifiedNativeChatCommands(agent)),
    [agent, structured]
  )
  const agentCommands = useOmpRpcCommands(
    agent,
    terminalTabId,
    staticAgentCommands,
    sessionCommands
  )
  const ompRpcCwd = useOmpRpcProbeCwd(agent, terminalTabId)
  return { agentCommands, ompRpcCwd }
}
