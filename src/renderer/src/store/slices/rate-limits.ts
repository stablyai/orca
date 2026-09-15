import type { StateCreator } from 'zustand'
import {
  getSettingsFocusedExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  createPendingRateLimitOwnerUsage,
  rateLimitOwnerUsageFromReading,
  type OwnedRateLimitsReading,
  type RateLimitOwnerContactLost,
  type RateLimitOwnerUnavailable,
  type RateLimitOwnerUsage
} from '../../../../shared/rate-limit-owner-usage'
import type { RateLimitRuntimeTarget, RateLimitState } from '../../../../shared/rate-limit-types'
import {
  readOwnedRateLimits,
  refreshOwnedRateLimits
} from '../../runtime/runtime-usage-owner-client'
import { getExecutionHostDisplayLabel } from '../../runtime/runtime-environment-display-name'
import type { AppState } from '../types'

export type OwnedRateLimitsUpdate = {
  hostId: ExecutionHostId
  /** Omitted for live pushes, which are never a reply to a superseded request. */
  generation?: number
  reading: OwnedRateLimitsReading
}

export type RateLimitSlice = {
  /**
   * Usage for the ACTIVE execution owner. Kept as a projection so every reader
   * (status bar, accounts pane, switchers) follows the owner without having to
   * know ownership exists.
   */
  rateLimits: RateLimitState
  /** Execution owner `rateLimits` describes. */
  rateLimitUsageHostId: ExecutionHostId
  /** Why the active owner's usage is missing; null while it is available. */
  rateLimitUsageUnavailable: RateLimitOwnerUnavailable | null
  /**
   * Set while the active owner has stopped confirming the usage on screen. The
   * numbers stay — losing the link is `unverifiable`, not a new reading.
   */
  rateLimitUsageContactLost: RateLimitOwnerContactLost | null
  rateLimitUsageByHost: Record<string, RateLimitOwnerUsage>
  setRateLimitUsageOwner: (hostId: ExecutionHostId) => void
  applyOwnedRateLimits: (update: OwnedRateLimitsUpdate) => void
  fetchRateLimits: () => Promise<void>
  refreshRateLimits: () => Promise<void>
  refreshGrokRateLimits: () => Promise<void>
  refreshClaudeRateLimitsForTarget: (target: RateLimitRuntimeTarget) => Promise<void>
  refreshCodexRateLimitsForTarget: (target: RateLimitRuntimeTarget) => Promise<void>
  consumeCodexRateLimitResetCredit: () => Promise<void>
  fetchInactiveClaudeAccountUsage: () => Promise<void>
  fetchInactiveCodexAccountUsage: () => Promise<void>
  setRateLimitsFromPush: (state: RateLimitState) => void
}

function localUsageReading(state: RateLimitState): OwnedRateLimitsReading {
  return { kind: 'usage', state, claudeAccountId: null, codexAccountId: null }
}

export const createRateLimitSlice: StateCreator<AppState, [], [], RateLimitSlice> = (set, get) => {
  const initialLocalUsage = createPendingRateLimitOwnerUsage(LOCAL_EXECUTION_HOST_ID, 1)

  // Resolves the owner from settings rather than trusting the projection, and
  // re-points the projection when settings moved first.
  const activeUsageHostId = (): ExecutionHostId => {
    const hostId = getSettingsFocusedExecutionHostId(get().settings)
    if (get().rateLimitUsageHostId !== hostId) {
      get().setRateLimitUsageOwner(hostId)
    }
    return hostId
  }

  const generationOf = (hostId: ExecutionHostId): number =>
    get().rateLimitUsageByHost[hostId]?.generation ?? 0

  const applyLocal = (hostId: ExecutionHostId, state: RateLimitState): void => {
    get().applyOwnedRateLimits({
      hostId,
      generation: generationOf(hostId),
      reading: localUsageReading(state)
    })
  }

  // Routes one owner-scoped read and applies it under that owner's generation.
  const runOwnedRequest = async (
    request: (hostId: ExecutionHostId, hostLabel: string) => Promise<OwnedRateLimitsReading>
  ): Promise<void> => {
    const hostId = activeUsageHostId()
    const generation = generationOf(hostId)
    const label = getExecutionHostDisplayLabel(get().runtimeEnvironments, hostId)
    get().applyOwnedRateLimits({ hostId, generation, reading: await request(hostId, label) })
  }

  // A host/WSL target names a slot on THIS machine. A paired runtime owns its
  // own runtime slots, so a target switch there is just a refresh of the owner.
  const refreshLocalProviderForTarget = async (
    provider: 'claude' | 'codex',
    target: RateLimitRuntimeTarget
  ): Promise<void> => {
    const hostId = activeUsageHostId()
    if (hostId !== LOCAL_EXECUTION_HOST_ID) {
      await get().refreshRateLimits()
      return
    }
    const generation = generationOf(hostId)
    const current = get().rateLimits
    const targetKey = provider === 'claude' ? 'claudeTarget' : 'codexTarget'
    const previousTarget = current[targetKey]
    const targetChanged =
      previousTarget.runtime !== target.runtime || previousTarget.wslDistro !== target.wslDistro
    const snapshot = current[provider]
    get().applyOwnedRateLimits({
      hostId,
      generation,
      reading: localUsageReading({
        ...current,
        [targetKey]: target,
        [provider]:
          snapshot && !targetChanged
            ? { ...snapshot, status: 'fetching' }
            : {
                provider,
                session: null,
                weekly: null,
                updatedAt: 0,
                error: null,
                status: 'fetching'
              }
      })
    })
    try {
      const state =
        provider === 'claude'
          ? await window.api.rateLimits.refreshClaudeForTarget(target)
          : await window.api.rateLimits.refreshCodexForTarget(target)
      get().applyOwnedRateLimits({ hostId, generation, reading: localUsageReading(state) })
    } catch (error) {
      console.error(`Failed to refresh ${provider} usage for runtime:`, error)
    }
  }

  // Local inactive-account usage lands via the desktop push; a paired runtime
  // refreshes its inactive accounts inside the same accounts.list call.
  const fetchInactiveAccountUsage = async (localFetch: () => Promise<void>): Promise<void> => {
    if (activeUsageHostId() !== LOCAL_EXECUTION_HOST_ID) {
      await get().refreshRateLimits()
      return
    }
    await localFetch()
  }

  return {
    rateLimits: initialLocalUsage.state,
    rateLimitUsageHostId: LOCAL_EXECUTION_HOST_ID,
    rateLimitUsageUnavailable: null,
    rateLimitUsageContactLost: null,
    rateLimitUsageByHost: { [LOCAL_EXECUTION_HOST_ID]: initialLocalUsage },

    setRateLimitUsageOwner: (hostId) => {
      if (get().rateLimitUsageHostId === hostId) {
        return
      }
      const byHost = get().rateLimitUsageByHost
      const cached = byHost[hostId]
      // Why: bumping on every activation is what makes switch A→B→A safe. A
      // reply still in flight from the FIRST visit to A carries the older
      // generation and is dropped instead of overwriting A's fresher state.
      const generation = (cached?.generation ?? 0) + 1
      const entry = cached
        ? { ...cached, generation }
        : createPendingRateLimitOwnerUsage(hostId, generation)
      set({
        rateLimitUsageHostId: hostId,
        rateLimitUsageByHost: { ...byHost, [hostId]: entry },
        rateLimits: entry.state,
        rateLimitUsageUnavailable: entry.unavailable,
        rateLimitUsageContactLost: entry.contactLost
      })
    },

    applyOwnedRateLimits: ({ hostId, generation, reading }) => {
      // Why: resolve the active owner from settings rather than from the
      // projection. A push can land before the owner subscription has run, and
      // trusting a not-yet-updated projection would show local usage under a
      // remote scope — the exact substitution this routing exists to prevent.
      const activeHostId = activeUsageHostId()
      const byHost = get().rateLimitUsageByHost
      const currentGeneration = byHost[hostId]?.generation ?? 0
      if (generation !== undefined && generation < currentGeneration) {
        return
      }
      const entry = rateLimitOwnerUsageFromReading(
        hostId,
        currentGeneration,
        reading,
        byHost[hostId]
      )
      const nextByHost = { ...byHost, [hostId]: entry }
      // Why: a late reply from a PREVIOUS owner still updates that owner's own
      // slot, but can never reach the projection the user is looking at.
      if (activeHostId !== hostId) {
        set({ rateLimitUsageByHost: nextByHost })
        return
      }
      set({
        rateLimitUsageByHost: nextByHost,
        rateLimits: entry.state,
        rateLimitUsageUnavailable: entry.unavailable,
        rateLimitUsageContactLost: entry.contactLost
      })
    },

    fetchRateLimits: async () => {
      try {
        await runOwnedRequest(readOwnedRateLimits)
      } catch (error) {
        console.error('Failed to fetch rate limits:', error)
      }
    },

    refreshRateLimits: async () => {
      try {
        await runOwnedRequest(refreshOwnedRateLimits)
      } catch (error) {
        console.error('Failed to refresh rate limits:', error)
      }
    },

    refreshGrokRateLimits: async () => {
      const hostId = activeUsageHostId()
      if (hostId !== LOCAL_EXECUTION_HOST_ID) {
        // Grok sign-in is read off this machine's disk; a paired runtime
        // republishes its own Grok usage through its accounts snapshot.
        await get().refreshRateLimits()
        return
      }
      try {
        applyLocal(hostId, await window.api.rateLimits.refreshGrok())
      } catch (error) {
        console.error('Failed to refresh Grok usage:', error)
      }
    },

    refreshClaudeRateLimitsForTarget: (target) => refreshLocalProviderForTarget('claude', target),

    refreshCodexRateLimitsForTarget: (target) => refreshLocalProviderForTarget('codex', target),

    consumeCodexRateLimitResetCredit: async () => {
      const hostId = activeUsageHostId()
      if (hostId !== LOCAL_EXECUTION_HOST_ID) {
        // The remote accounts.consumeCodexResetCredit RPC needs an idempotency
        // key and an expected scope this surface does not compute, and a finite
        // credit spent against the wrong owner cannot be recovered.
        throw new Error('Codex rate-limit resets are only available for local accounts.')
      }
      try {
        const result = await window.api.rateLimits.consumeCodexResetCredit()
        applyLocal(hostId, result.state)
      } catch (error) {
        console.error('Failed to consume Codex rate-limit reset:', error)
        throw error
      }
    },

    fetchInactiveClaudeAccountUsage: async () => {
      try {
        await fetchInactiveAccountUsage(window.api.rateLimits.fetchInactiveClaudeAccounts)
      } catch (error) {
        console.error('Failed to fetch inactive Claude account usage:', error)
      }
    },

    fetchInactiveCodexAccountUsage: async () => {
      try {
        await fetchInactiveAccountUsage(window.api.rateLimits.fetchInactiveCodexAccounts)
      } catch (error) {
        console.error('Failed to fetch inactive Codex account usage:', error)
      }
    },

    setRateLimitsFromPush: (state) => {
      // Why: the desktop push is always LOCAL usage, and it is not a reply to a
      // request, so it carries no generation. Routing it to the local slot is
      // what stops it overwriting a remote owner's display — #15798 / #16466.
      get().applyOwnedRateLimits({
        hostId: LOCAL_EXECUTION_HOST_ID,
        reading: localUsageReading(state)
      })
    }
  }
}
