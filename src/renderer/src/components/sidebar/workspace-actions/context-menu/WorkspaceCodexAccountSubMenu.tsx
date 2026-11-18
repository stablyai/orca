import { WorkspaceProviderAccountSubMenu } from './WorkspaceProviderAccountSubMenu'
import type { Worktree } from '../../../../../../shared/worktree/types'

export function WorkspaceCodexAccountSubMenu(props: { worktree: Worktree; disabled: boolean }) {
  return <WorkspaceProviderAccountSubMenu {...props} provider="codex" />
}
