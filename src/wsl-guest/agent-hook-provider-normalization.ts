import { hasOtherAgentProcessOwner } from '../shared/agent-status/process/agent-process-presence'
import {
  isOwnerProviderGuestHook,
  readHookProcessVerdict
} from '../shared/agent-hook-listener/presence/agent-hook-owner-presence'
import { retainHookRootContext } from '../shared/agent-hook-listener/pane-provider-session'
import { sameAgentStatusTerminalOwner } from '../shared/agent-status/identity/agent-status-terminal-owner'
import { normalizeHookPayload } from '../shared/agent-hook-listener/normalization/normalize-hook-payload'
import {
  clearPaneCacheState,
  createHookListenerState,
  type HookListenerState
} from '../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../shared/agent-hook-listener/transport/agent-hook-relay'
import { cacheRelayLegacyAgentStatus } from '../shared/agent-status/transport/agent-status-legacy-relay-cache'
import { MAX_CACHED_PANES } from './agent-hook-cached-pane-status'
import { readClaudeTaskNotificationEvidenceFromBody } from '../shared/agent-hook-listener/providers/claude-task-notification-evidence-reader'

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
    return this.normalizeWithOptions(canonical, source, body, env, options)
  }

  async normalizeAsync(
    canonical: HookListenerState,
    source: AgentHookSource,
    body: unknown,
    env: string,
    options: Parameters<typeof normalizeHookPayload>[4] = {}
  ): Promise<AgentHookEventPayload | null> {
    if (source !== 'claude') {
      return this.normalizeWithOptions(canonical, source, body, env, options)
    }
    const transcriptEvidence = await readClaudeTaskNotificationEvidenceFromBody(canonical, body)
    return this.normalizeWithOptions(canonical, source, body, env, {
      ...options,
      claudeTaskTranscriptEvidence: transcriptEvidence
    })
  }

  private normalizeWithOptions(
    canonical: HookListenerState,
    source: AgentHookSource,
    body: unknown,
    env: string,
    options: Parameters<typeof normalizeHookPayload>[4]
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
    const normalized = normalizeHookPayload(view, source, body, env, {
      ...options,
      bindingStatusByPaneKey: canonical.lastStatusByPaneKey
    })
    const previous = normalized ? state.lastStatusByPaneKey.get(normalized.paneKey) : undefined
    const event =
      normalized && source === 'codex'
        ? retainHookRootContext(
            normalized,
            previous && sameAgentStatusTerminalOwner(previous, normalized) ? previous : undefined,
            true,
            true,
            undefined
          )
        : normalized
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
        }) &&
        readHookProcessVerdict(canonical, owner, {
          paneKey: event.paneKey,
          process: event.agentPresence?.process
        }) !== 'root'
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
