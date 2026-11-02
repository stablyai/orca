import { useEffect, useState } from 'react'
import { useTerminalQuickCommandHosts } from '@/hooks/use-terminal-quick-command-hosts'
import { useVisibleTerminalQuickCommandHosts } from '@/hooks/use-visible-terminal-quick-command-hosts'
import { useAppStore } from '@/store'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { getTerminalQuickCommandHostPromptMaxLength } from '@/lib/terminal-quick-command-host-prompt-limit'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { runQuickCommandInNewTab } from '@/lib/run-quick-command-in-new-tab'
import { TerminalQuickCommandsSubmenu } from '../terminal-pane/TerminalQuickCommandsSubmenu'
import {
  createTerminalQuickCommandDraft,
  TerminalQuickCommandDialog
} from '../terminal-quick-commands/TerminalQuickCommandDialog'

export function useNativeChatQuickCommandsMenu(
  pane: { worktreeId: string; groupId: string } | undefined,
  open: boolean,
  close: () => void
) {
  const repos = useAppStore((state) => state.repos)
  const worktreeId = pane?.worktreeId ?? ''
  const candidate =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ? null : getRepoIdFromWorktreeId(worktreeId)
  const repo = repos.find((entry) => entry.id === candidate)
  const repoId = repo?.id ?? null
  const { hosts, executionHostId, refreshRemoteHost, remoteHostLoadFailed, remoteHostPending } =
    useTerminalQuickCommandHosts(worktreeId, Boolean(pane) && open)
  const visibleHosts = useVisibleTerminalQuickCommandHosts(hosts, executionHostId, repoId)
  const [editor, setEditor] = useState<{
    hostId: ExecutionHostId
    command: TerminalQuickCommand
  } | null>(null)
  const editorHost = editor?.hostId
  const promptMaxLength = useAppStore((state) =>
    editorHost ? getTerminalQuickCommandHostPromptMaxLength(state, editorHost) : undefined
  )
  const enabled = Boolean(pane) && open
  useEffect(() => {
    if (enabled) {
      refreshRemoteHost()
    }
  }, [enabled, refreshRemoteHost])
  return {
    menu:
      pane && repoId ? (
        <TerminalQuickCommandsSubmenu
          hosts={visibleHosts}
          hostLoadFailed={remoteHostLoadFailed}
          hostOwnershipPending={remoteHostPending}
          repoLabel={repo?.displayName || repo?.path || null}
          onAdd={(hostId) =>
            setEditor({
              hostId,
              command: createTerminalQuickCommandDraft({ type: 'repo', repoId: repoId ?? '' })
            })
          }
          onClose={close}
          onRun={(command, historyId) =>
            runQuickCommandInNewTab({ command, historyId, worktreeId, groupId: pane.groupId })
          }
        />
      ) : null,
    dialog:
      editor && editorHost ? (
        <TerminalQuickCommandDialog
          open
          mode="add"
          command={editor.command}
          repos={
            editorHost.startsWith('runtime:')
              ? repos.filter((entry) => getRepoExecutionHostId(entry) === editorHost)
              : repos
          }
          agentPromptMaxLength={promptMaxLength}
          onOpenChange={(nextOpen) => !nextOpen && setEditor(null)}
          onSave={(command) =>
            useAppStore.getState().upsertTerminalQuickCommand(editorHost, command)
          }
        />
      ) : null
  }
}
