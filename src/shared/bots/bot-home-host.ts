// The host whose workspaces hold a bot's home. A bot's own host, except an agent shared with this
// account: its owner lists none of their workspaces to it, so its home is a workspace on this computer.
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../execution-host/execution-host'

// The window's shared-agents catalog answers this; elsewhere (main, the phone) no host is shared.
let isSharedBotHost: (environmentId: string) => boolean = () => false

export function setSharedBotHostLookup(lookup: (environmentId: string) => boolean): () => void {
  isSharedBotHost = lookup
  return () => {
    isSharedBotHost = () => false
  }
}

/** Every pairing of a bot with its home workspace or the tabs kept there asks this, never `hostId`. */
export function botHomeHostId(bot: { hostId: ExecutionHostId }): ExecutionHostId {
  const parsed = parseExecutionHostId(bot.hostId)
  return parsed?.kind === 'runtime' && isSharedBotHost(parsed.environmentId)
    ? LOCAL_EXECUTION_HOST_ID
    : bot.hostId
}
