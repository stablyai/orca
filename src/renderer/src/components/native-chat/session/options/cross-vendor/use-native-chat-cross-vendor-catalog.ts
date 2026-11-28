import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { isBotAgent } from '../../../../../../../shared/bot-types'
import { translate } from '@/i18n/i18n'
import type { AgentSessionUnavailable } from '../../../../../../../shared/agent-session/failures/agent-session-availability'
import { detectAgentSessionContinuationAgents } from '@/lib/agent-session/launch/continuation/launch-agent-session-continuation'
import { agentChoiceOpensAsChat } from '@/lib/agent-session/launch/inventory/host-chat-program'
import { worktreeLaunchWorkspace } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { readModelMenuCatalog } from '@/runtime/native-chat/model-catalogs/model-menu-catalog-read'
import { subscribeModelMenuInvalidation } from '@/runtime/native-chat/model-catalogs/model-menu-invalidation'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { isTuiAgentEnabled } from '../../../../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentSessionModelOption } from '../../../../../../../shared/agent-session/options/model-catalog/agent-session-model-option'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type CrossVendorModels =
  | { state: 'loading' }
  | { state: 'ready'; models: AgentSessionModelOption[] }
  /** The host could not list them; the agent's default model still starts. */
  | { state: 'unknown'; reason?: string }

export type CrossVendorCatalog = {
  /** Agents on this chat's host that open as a chat, the chat's own first; null while detecting. */
  vendors: TuiAgent[] | null
  models: Partial<Record<TuiAgent, CrossVendorModels>>
}

const EMPTY_CATALOG: CrossVendorCatalog = { vendors: null, models: {} }

/** Read only while the picker is open: detection and listings can start provider probes. */
export function useNativeChatCrossVendorCatalog(input: {
  open: boolean
  worktreeId: string | null
  target: RuntimeClientTarget
  currentAgent: string
  botOnly?: boolean
}): CrossVendorCatalog {
  const { open, worktreeId, target, currentAgent, botOnly = false } = input
  const [revision, setRevision] = useState(0)
  const scope = JSON.stringify([worktreeId, target, currentAgent, botOnly, revision])
  const [catalog, setCatalog] = useState<(CrossVendorCatalog & { scope: string }) | null>(null)
  useEffect(
    () =>
      open
        ? subscribeModelMenuInvalidation(target, () => setRevision((value) => value + 1))
        : undefined,
    [open, target]
  )
  useEffect(() => {
    if (!open || !worktreeId) {
      return
    }
    const abort = new AbortController()
    void (async () => {
      let detected: readonly TuiAgent[] | null = null
      let offered: readonly TuiAgent[] = []
      try {
        const choices = await detectAgentSessionContinuationAgents(worktreeId, abort.signal)
        detected = choices.detected
        offered = choices.offered
      } catch {
        offered = []
      }
      if (abort.signal.aborted) {
        return
      }
      const state = useAppStore.getState()
      const workspace = worktreeLaunchWorkspace(worktreeId)
      const vendors = offered.filter(
        (agent) =>
          isTuiAgentEnabled(agent, state.settings?.disabledTuiAgents) &&
          (!botOnly || isBotAgent(agent)) &&
          (agent === currentAgent ||
            agentChoiceOpensAsChat(state, agent, workspace, detected, 'chat'))
      )
      const ordered = [
        ...vendors.filter((agent) => agent === currentAgent),
        ...vendors.filter((agent) => agent !== currentAgent)
      ]
      setCatalog((current) => ({
        scope,
        vendors: ordered,
        models: Object.fromEntries(
          ordered.map((agent) => [
            agent,
            (current?.scope === scope && current.models[agent]) || { state: 'loading' }
          ])
        )
      }))
      await Promise.all(
        ordered
          .filter((agent) => agent !== currentAgent)
          .map(async (agent) => {
            let models: CrossVendorModels
            try {
              const answer = await readModelMenuCatalog(
                { target, agent, worktree: toRuntimeWorktreeSelector(worktreeId) },
                true,
                abort.signal
              )
              models =
                !answer || answer.origin === 'unknown' || answer.models.length === 0
                  ? {
                      state: 'unknown',
                      ...(answer?.unavailable
                        ? { reason: unavailableText(answer.unavailable) }
                        : {})
                    }
                  : { state: 'ready', models: answer.models }
            } catch (error) {
              models = {
                state: 'unknown',
                reason: error instanceof Error ? error.message : String(error)
              }
            }
            if (!abort.signal.aborted) {
              setCatalog((current) =>
                current?.scope === scope
                  ? { ...current, models: { ...current.models, [agent]: models } }
                  : current
              )
            }
          })
      )
    })()
    return () => abort.abort()
  }, [open, worktreeId, target, currentAgent, botOnly, scope])
  return catalog?.scope === scope ? catalog : EMPTY_CATALOG
}

function unavailableText(unavailable: AgentSessionUnavailable): string {
  return unavailable.reason === 'notSignedIn'
    ? translate('components.native-chat.crossVendor.notSignedIn', 'Not signed in')
    : unavailable.reason === 'cliMissing'
      ? translate('components.native-chat.crossVendor.cliMissing', 'Not installed on this host')
      : translate('components.native-chat.crossVendor.notRunnable', 'Cannot start on this host')
}
