import { TUI_AGENT_CONFIG } from '../agent-launch/catalog/tui-agent-config'

/** Every known agent saved to open as a chat, since an agent without a saved choice opens its CLI. */
export const EVERY_AGENT_CHAT: Readonly<Record<string, boolean>> = Object.fromEntries(
  Object.keys(TUI_AGENT_CONFIG).map((agent) => [agent, true])
)
