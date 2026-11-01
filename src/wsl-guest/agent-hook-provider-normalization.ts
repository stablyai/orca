import { hasOtherAgentProcessOwner } from '../shared/agent-process-presence'
import { isOwnerProviderGuestHook } from '../shared/agent-hook-owner-presence'
import { sameAgentStatusTerminalOwner } from '../shared/agent-status-terminal-owner'
import { normalizeHookPayload } from '../shared/agent-hook-listener'
import {
  clearPaneCacheState,
  createHookListenerState,
  type HookListenerState
} from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../shared/agent-hook-relay'
import { cacheRelayLegacyAgentStatus } from '../shared/agent-status-legacy-relay-cache'
import { MAX_CACHED_PANES } from './agent-hook-cached-pane-status'

/** Forward every provider; only the client knows about desktop-only owner completion. */
export class RelayProviderHookNormalization {
  private readonly states = new Map<AgentHookSource, HookListenerState>()

  normalize(
    canonical: HookListenerState,
    source: AgentHookSource,
    body: unknown,
    env: string,
    options: Parameters<typeof normalizeHookPayload>[4] = {}
  ): AgentHookEventPayload | null {
    // Why: the owner's own provider folds would take the guest's prompt and tools.
    if (isOwnerProviderGuestHook(canonical, source, body, env)) {
      return null
    }
    let state = this.states.get(source)
    if (!state) {
      state = createHookListenerState()
      this.states.set(source, state)
    }
    // Provider folds stay in the execution host; generic fields cannot leak between providers.
    const view: HookListenerState = {
      ...canonical,
      lastPromptByPaneKey: state.lastPromptByPaneKey,
      lastToolByPaneKey: state.lastToolByPaneKey,
      lastStatusByPaneKey: state.lastStatusByPaneKey
    }
    const event = normalizeHookPayload(view, source, body, env, {
      ...options,
      bindingStatusByPaneKey: canonical.lastStatusByPaneKey
    })
    if (event) {
      const providerState = state
      cacheRelayLegacyAgentStatus(state, event, MAX_CACHED_PANES, (paneKey) =>
        clearPaneCacheState(providerState, paneKey)
      )
      const owner = canonical.lastStatusByPaneKey.get(event.paneKey)
      if (
        owner &&
        !owner.providerSessionOnly &&
        sameAgentStatusTerminalOwner(owner, event) &&
        hasOtherAgentProcessOwner(owner.agentPresence, {
          agent: source,
          process: event.agentPresence?.process
        })
      ) {
        return event
      }
      const prompt = state.lastPromptByPaneKey.get(event.paneKey)
      const tool = state.lastToolByPaneKey.get(event.paneKey)
      if (prompt !== undefined) {
        canonical.lastPromptByPaneKey.set(event.paneKey, prompt)
      } else {
        canonical.lastPromptByPaneKey.delete(event.paneKey)
      }
      if (tool !== undefined) {
        canonical.lastToolByPaneKey.set(event.paneKey, tool)
      } else {
        canonical.lastToolByPaneKey.delete(event.paneKey)
      }
    }
    return event
  }

  clearPane(paneKey: string): void {
    for (const state of this.states.values()) {
      clearPaneCacheState(state, paneKey)
    }
  }

  clear(): void {
    this.states.clear()
  }
}
