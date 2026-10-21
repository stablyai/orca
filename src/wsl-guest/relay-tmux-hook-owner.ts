import type { AgentStatusStore } from '../shared/agent-status-store'
import { commitTmuxSelectedStatus, commitTmuxUnavailable } from '../shared/tmux-selected-status'
import { TmuxAgentHookOwner, type TmuxManagedPty } from '../shared/tmux-agent-hook-owner'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'
import type { AgentHookUnavailableEnvelope } from '../shared/agent-hook-relay'

export function createRelayTmuxHookOwner(options: {
  getRoot?: (paneKey: string) => Promise<TmuxManagedPty | null>
  isRetired: (paneKey: string) => boolean
  store: () => AgentStatusStore
  publish: (event: AgentHookEventPayload) => void
  takeLegacyIdentity: (paneKey: string) => AgentHookEventPayload | undefined
  forwardUnavailable?: (envelope: AgentHookUnavailableEnvelope) => void
}): TmuxAgentHookOwner | undefined {
  if (!options.getRoot) {
    return undefined
  }
  return new TmuxAgentHookOwner({
    store: options.store,
    getRoot: options.getRoot,
    isRetired: options.isRetired,
    publish: (event, observedAt, subject, stateStartedAt) => {
      const status = commitTmuxSelectedStatus(
        options.store(),
        subject,
        event,
        observedAt,
        stateStartedAt
      )
      if (!status) {
        return
      }
      options.publish({ ...event, hostEvidenceObservedAt: status.evidenceObservedAt })
    },
    unavailable: (paneKey, subject, identity) => {
      if (!subject) {
        return
      }
      const prior = options.takeLegacyIdentity(paneKey)
      const envelope = commitTmuxUnavailable(options.store(), subject, prior ?? identity)
      if (envelope) {
        options.forwardUnavailable?.(envelope)
      }
    }
  })
}
