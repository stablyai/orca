/**
 * Settings › MCP servers › one server's page, on the host it was opened for (its environment id, null
 * for this computer); `title` fills in once the server is read.
 */
export type McpServerSubPage = { id: string; title: string; host: string | null }
