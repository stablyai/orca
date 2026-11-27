import { refreshBotGitHub } from './bot-github-state'
import { refreshBotLinear } from './bot-linear-state'
import { refreshBotCliq } from './bot-cliq-state'
import type { ConnectorConnectSource } from '../../../shared/connectors/connector-cloud-contract'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'

// What a trip's link changes on the host. A Slack sign-in only adds a link, which no host state shows.
export const REFRESH: Record<
  ConnectorConnectSource,
  (hostId: ExecutionHostId) => Promise<unknown>
> = {
  linear: refreshBotLinear,
  github: refreshBotGitHub,
  slack: () => Promise.resolve(),
  cliq: refreshBotCliq
}
