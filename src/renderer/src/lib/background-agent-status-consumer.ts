import { useAppStore } from '@/store'
import { createAgentStatusOscProcessor } from '../../../shared/agent-status-osc'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import {
  resolveLiveAgentStatusConnectionRouting,
  type AgentStatusConnectionRouting
} from './agent-status-connection-ownership'

export function createBackgroundAgentStatusConsumer(args: {
  paneKey: string
  launchToken: string
  mainOwnsAgentStatusWrites: boolean
  expectedConnectionId: string | null | undefined
  runtimeEnvironmentId: string | null
  getPtyId: () => string
  onAgentStatus?: (payload: ParsedAgentStatusPayload) => void
}): {
  consume: (data: string) => void
  resolveRouting: () => AgentStatusConnectionRouting | undefined
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
          useAppStore
            .getState()
            .setAgentStatus(args.paneKey, payload, undefined, undefined, routing, {
              launchToken: args.launchToken
            })
        }
      }
      args.onAgentStatus?.(payload)
    }
  }
  return { consume, resolveRouting }
}
