import type { Tab } from '../../../../shared/tab-types'
import { useAppStore } from '@/store'
import {
  getRuntimeEnvironmentIdForWorktree,
  getSshConnectionIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { DatabasePaneContent } from './DatabasePaneContent'

export default function DatabasePane({
  tab,
  isActive = true
}: {
  tab: Tab
  isActive?: boolean
}): React.JSX.Element {
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, tab.worktreeId)
  )
  const sshConnectionId = useAppStore((state) =>
    getSshConnectionIdForWorktree(state, tab.worktreeId)
  )
  const owner = JSON.stringify([tab.id, tab.worktreeId, runtimeEnvironmentId, sshConnectionId])
  return (
    <DatabasePaneContent
      key={owner}
      tab={tab}
      isActive={isActive}
      runtimeEnvironmentId={runtimeEnvironmentId}
      sshConnectionId={sshConnectionId}
    />
  )
}
