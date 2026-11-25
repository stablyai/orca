import { hostWindowEvent } from './host-window-event'

/** A host's MCP server list changed (another window, a phone or the CLI edited it), so its pages re-read. */
const mcpServersChanged = hostWindowEvent('orca:mcp-servers-changed')

export const emitMcpServersChangedWindowEvent = mcpServersChanged.emit
export const onMcpServersChanged = mcpServersChanged.on
