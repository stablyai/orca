import { useAppStore } from '@/store/index'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

/** Opens Settings › MCP servers on `hostScope`; `serverId` opens that server's page. */
export function openMcpServersSettings(hostScope: RuntimeClientTarget, serverId?: string): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  openSettingsTarget({
    pane: 'mcp-servers',
    repoId: null,
    hostScope,
    ...(serverId ? { sectionId: serverId } : {})
  })
  openSettingsPage()
}
