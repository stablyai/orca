// Opens a file in a bot's home as an editor tab on the bot's page, for edits longer than Settings' fields suit.
import { toast } from 'sonner'
import { openBotHome } from '@/lib/bot-catalog'
import { botTarget } from '@/lib/bot-hosts'
import { runtimeTargetEnvironmentId } from '@/runtime/rpc/targets/runtime-client-target'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Bot } from '../../../../../shared/bot-types'
import { detectLanguage } from '../../../../../shared/editor-language/editor-language-detect'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { botHomePath, type BotHome } from './bot-home-files'

export function openBotHomeFileTab(bot: Bot, home: BotHome, relativePath: string): void {
  if (!openBotHome(bot)) {
    toast.error(
      translate('bots.settingsView.openFileFailed', 'Couldn’t open {{name}}’s folder.', {
        name: bot.name
      })
    )
    return
  }
  const environmentId = runtimeTargetEnvironmentId(botTarget(bot))
  useAppStore.getState().openFile(
    {
      filePath: botHomePath(home, relativePath),
      relativePath,
      worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
      runtimeEnvironmentId: environmentId ?? undefined,
      language: detectLanguage(relativePath),
      mode: 'edit'
    },
    { focusEditor: true, suppressActiveRuntimeFallback: environmentId === null }
  )
}
