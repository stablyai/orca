import React from 'react'
import { useActiveWorktree, useRepoById } from '@/store/selectors'
import { LocalWorkspacePortsPanel } from './local-workspace-ports-panel'
import { SshPortsPanel } from './ssh-ports-panel'

export { getLocalWorkspacePortSections } from './local-workspace-port-sections'
export {
  killWorkspacePortForTarget,
  openWorkspacePortInBrowser,
  scanWorkspacePortsForTarget
} from '@/lib/workspace-port-actions'

export default function PortsPanel({ isVisible }: { isVisible: boolean }): React.JSX.Element {
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)

  if (activeRepo?.connectionId) {
    return <SshPortsPanel />
  }

  return <LocalWorkspacePortsPanel isVisible={isVisible} />
}
