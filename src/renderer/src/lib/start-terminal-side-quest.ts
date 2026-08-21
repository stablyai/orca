import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { seedNativeChatSideQuestContext } from '@/components/native-chat/native-chat-side-quest-context-cache'
import { seedNativeChatSideQuestReadiness } from '@/components/native-chat/native-chat-side-quest-readiness-cache'
import { waitForAgentReady } from './agent-ready-wait'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { createSideQuestQuotedContext } from './side-quest-context'
import { launchSideQuest, type LaunchSideQuestResult } from './launch-side-quest'
import type { SideQuestAgent } from './side-quest-agent'

const SIDE_QUEST_AGENT_READINESS_TIMEOUT_MS = 30_000

export function startTerminalSideQuest(args: {
  worktreeId: string
  sourceGroupId: string | null
  agent: SideQuestAgent
  capturedText: string
  sourceLabel: string
}): LaunchSideQuestResult {
  const quotedContext = createSideQuestQuotedContext(args.capturedText, args.sourceLabel)
  const result = launchSideQuest({
    ...args,
    beforeOpenChat: (terminalTabId, transport) => {
      if (transport !== 'provider') {
        // Why: subscribe before native chat mounts so a fast TUI cannot emit
        // its one-time input-ready handshake before the composer starts waiting.
        seedNativeChatSideQuestReadiness(
          terminalTabId,
          waitForAgentReady(terminalTabId, TUI_AGENT_CONFIG[args.agent].expectedProcess, {
            timeoutMs: SIDE_QUEST_AGENT_READINESS_TIMEOUT_MS
          }).then((ready) => ready.ready)
        )
      }
      if (quotedContext) {
        seedNativeChatSideQuestContext(terminalTabId, quotedContext)
      }
    }
  })

  if (result.status === 'started') {
    return result
  }

  toast.error(
    result.status === 'runtime-unsupported'
      ? translate(
          'auto.lib.start.terminal.side.quest.runtime.unsupported',
          'Side Quests are not available in runtime-hosted workspaces yet.'
        )
      : translate('auto.lib.start.terminal.side.quest.failed', 'Could not start a Side Quest.')
  )
  return result
}
