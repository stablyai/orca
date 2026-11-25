import { useEffect, useState } from 'react'
import { useTerminalQuickCommandHosts } from '@/lib/terminal/quick-commands/use-terminal-quick-command-hosts'
import { useVisibleTerminalQuickCommandHosts } from '@/lib/terminal/quick-commands/use-visible-terminal-quick-command-hosts'
import { useAppStore } from '@/store/index'
import { getIndexedReposById } from '@/store/repos/repository-catalog-index'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../../shared/workspace/identity/floating-workspace-id'
import type { TerminalQuickCommand } from '../../../../../../shared/terminal/quick-commands/terminal-quick-command-types'
import { runQuickCommandInNewTab } from '@/lib/terminal/quick-commands/run-quick-command-in-new-tab'
import { TerminalQuickCommandsSubmenu } from '../../../terminal-pane/quick-commands/TerminalQuickCommandsSubmenu'
import { TerminalQuickCommandEditorDialog } from '../../../terminal-pane/quick-commands/TerminalQuickCommandEditorDialog'
import { createTerminalQuickCommandDraft } from '../../../terminal-quick-commands/TerminalQuickCommandDialog'
import { useQuickCommandEditorPresence } from '../../../tab-bar/quick-commands/quick-command-editor-presence'

type QuickCommandEditor = { hostId: ExecutionHostId; command: TerminalQuickCommand }
type QuickCommandPane = { worktreeId: string; groupId: string }

// Why: every retained chat mounts this hook, so it holds only the inert editor
// state; menu data is read by components that live with the open menu content.
export function useNativeChatQuickCommandsMenu(
  pane: QuickCommandPane | undefined,
  close: () => void,
  /** Where focus lands when the editor closes; its opener (a menu row) is gone by then. */
  onEditorCloseAutoFocus?: (event: Event) => void
) {
  const [editor, setEditor] = useState<QuickCommandEditor | null>(null)
  // The dialog's unsaved text lives here; while it's open its workspace must keep its layout mounted.
  useQuickCommandEditorPresence(pane?.worktreeId ?? '', editor !== null && pane !== undefined)
  return {
    menu: pane ? (
      <NativeChatQuickCommandsMenuItems pane={pane} onAdd={setEditor} onClose={close} />
    ) : null,
    dialog: editor ? (
      <TerminalQuickCommandEditorDialog
        command={editor.command}
        hostId={editor.hostId}
        onOpenChange={(nextOpen) => !nextOpen && setEditor(null)}
        onSave={(command) =>
          useAppStore.getState().upsertTerminalQuickCommand(editor.hostId, command)
        }
        onCloseAutoFocus={onEditorCloseAutoFocus}
      />
    ) : null
  }
}

function NativeChatQuickCommandsMenuItems({
  pane,
  onAdd,
  onClose
}: {
  pane: QuickCommandPane
  onAdd: (editor: QuickCommandEditor) => void
  onClose: () => void
}): React.JSX.Element | null {
  const { worktreeId, groupId } = pane
  const candidate =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ? null : getRepoIdFromWorktreeId(worktreeId)
  const repo = useAppStore((state) =>
    candidate ? (getIndexedReposById(state.repos, candidate)[0] ?? null) : null
  )
  const repoId = repo?.id ?? null
  const { hosts, executionHostId, refreshRemoteHost, remoteHostLoadFailed, remoteHostPending } =
    useTerminalQuickCommandHosts(worktreeId)
  const visibleHosts = useVisibleTerminalQuickCommandHosts(hosts, executionHostId, repoId)
  useEffect(() => {
    refreshRemoteHost()
  }, [refreshRemoteHost])
  if (!repoId) {
    return null
  }
  return (
    <TerminalQuickCommandsSubmenu
      hosts={visibleHosts}
      hostLoadFailed={remoteHostLoadFailed}
      hostOwnershipPending={remoteHostPending}
      repoLabel={repo?.displayName || repo?.path || null}
      // Chat menus run every command in a new tab, which runs it even without Enter.
      showInsertHint={false}
      onAdd={(hostId) =>
        onAdd({ hostId, command: createTerminalQuickCommandDraft({ type: 'repo', repoId }) })
      }
      onClose={onClose}
      onRun={(command, historyId) =>
        runQuickCommandInNewTab({ command, historyId, worktreeId, groupId })
      }
    />
  )
}
