import { useAppStore } from '@/store'
import { beginDesktopNavigation } from '@/lib/desktop-navigation'
import { useThreadDraft, type ThreadDraft } from './thread-navigation'

/** Fixture pages enter the same app route as the real interactions; content alone cannot open compose. */
export function setThreadTestPage(state: {
  selection?:
    | ThreadDraft
    | { kind: 'workbench'; worktreeId: string; executionHostId: string | null }
    | null
  projectRequest?: null
}) {
  if ('selection' in state) {
    beginDesktopNavigation()
    useThreadDraft.setState({
      draft: state.selection?.kind === 'new' ? state.selection : null,
      unallocated: 0
    })
    useAppStore.setState({
      activeView:
        state.selection?.kind === 'new'
          ? 'thread-draft'
          : state.selection?.kind === 'workbench'
            ? 'empty-workbench'
            : 'terminal'
    })
  }
  if ('projectRequest' in state) {
    useThreadDraft.setState({ projectRequest: state.projectRequest })
  }
}
