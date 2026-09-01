import { useAppStore } from '@/store'
import { createAgentStatusOscProcessor } from '../../../shared/agent-status-osc'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import {
  resolveLiveAgentStatusConnectionRouting,
  type AgentStatusConnectionRouting
} from './agent-status-connection-ownership'
import { rendererAgentStatusObservations } from './renderer-agent-status-observations'
import type { AgentStatusObservation } from '../../../shared/agent-status-observation'

export function createBackgroundAgentStatusConsumer(args: {
  paneKey: string
  getLaunchToken: () => string | null
  mainOwnsAgentStatusWrites: boolean
  expectedConnectionId: string | null | undefined
  runtimeEnvironmentId: string | null
  getPtyId: () => string
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
}): {
  consume: (data: string) => void
  resolveRouting: () => AgentStatusConnectionRouting | undefined
  /** Stamp a launch-origin observation for this pane (STA-4293). Lives here because this
   *  consumer already owns the pane's status ingress; callers seeding a launch row need the
   *  same authority the byte path writes under. */
  observeLaunchIngress: () => AgentStatusObservation
} {
  const processAgentStatus = createAgentStatusOscProcessor()
  const resolveRouting = (): AgentStatusConnectionRouting | undefined => {
    const ptyId = args.getPtyId()
    const state = useAppStore.getState()
    return resolveLiveAgentStatusConnectionRouting({
      state,
      paneKey: args.paneKey,
      ptyId,
      expectedConnectionId: args.expectedConnectionId,
      runtimeEnvironmentId: args.runtimeEnvironmentId
    })
  }
  const consume = (data: string): void => {
    const processed = processAgentStatus(data)
    for (const payload of processed.payloads) {
      if (!args.mainOwnsAgentStatusWrites) {
        const routing = resolveRouting()
        // Why: hidden callbacks can outlive tab reuse; only the exact current
        // pane-to-PTY binding may update its status ownership.
        if (routing) {
          const launchToken = args.getLaunchToken()
          useAppStore.getState().setAgentStatus(
            args.paneKey,
            {
              ...payload,
              observation: rendererAgentStatusObservations.observe(args.paneKey, {
                origin: 'osc',
                observedAt: Date.now(),
                kind: 'snapshot'
              })
            },
            undefined,
            undefined,
            routing,
            launchToken ? { launchToken } : undefined
          )
        }
      }
      args.onAgentStatus?.(payload)
    }
  }
  const observeLaunchIngress = (): AgentStatusObservation =>
    rendererAgentStatusObservations.observe(args.paneKey, {
      origin: 'launch',
      observedAt: Date.now(),
      kind: 'transition'
    })
  return { consume, resolveRouting, observeLaunchIngress }
}
