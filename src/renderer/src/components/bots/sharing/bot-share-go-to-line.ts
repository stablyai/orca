// *Go to line*: the flagged file of a bot's home, opened in its home workspace at that line.
import { openBotHome } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import { openLinkedFileInEditor } from '@/components/terminal-pane/links/files/terminal-file-link-editor-open'
import { selectFolderWorkspaceOnHost } from '@/store/folder-workspaces/folder-workspace-record-index'
import { resolveRuntimePath } from '../../../../../shared/file-access/cross-platform-path'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import type { Bot } from '../../../../../shared/bot-types'

/** False when the bot's home can't open here. */
export function openBotHomeFileAtLine(bot: Bot, homePath: string, line: number): boolean {
  const state = useAppStore.getState()
  const folderPath = selectFolderWorkspaceOnHost(
    state,
    bot.folderWorkspaceId,
    bot.hostId
  )?.folderPath
  if (!folderPath || !openBotHome(bot)) {
    return false
  }
  state.closeSettingsPage()
  return (
    openLinkedFileInEditor(
      {
        filePath: resolveRuntimePath(folderPath, homePath),
        relativePath: homePath,
        worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
        runtimeEnvironmentId: null
      },
      null,
      { line, column: 1 },
      () => true
    ) !== null
  )
}
