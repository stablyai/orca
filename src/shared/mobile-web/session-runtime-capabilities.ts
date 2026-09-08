export type HostSessionRuntimeCapabilities = {
  browserScreencastSupported: boolean
  agentHistorySupported: boolean
  quickCommandsSupported: boolean
  terminalQueryReplyInputSupported: boolean
}

export function projectHostSessionRuntimeCapabilities(
  capabilities: readonly string[]
): HostSessionRuntimeCapabilities {
  return {
    browserScreencastSupported: capabilities.includes('browser.screencast.v1'),
    agentHistorySupported: capabilities.includes('aiVault.v1'),
    quickCommandsSupported: capabilities.includes('terminal.quick-commands.v1'),
    terminalQueryReplyInputSupported: capabilities.includes('terminal.query-reply-input.v1')
  }
}
