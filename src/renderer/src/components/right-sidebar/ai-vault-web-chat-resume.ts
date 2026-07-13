import { toast } from 'sonner'
import type { TuiAgent } from '../../../../shared/types'
import type { AiVaultSession, WebChatAgent } from '../../../../shared/ai-vault-types'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { isNativeChatSupportedAgent } from '@/lib/native-chat-supported-agent'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { buildWebChatResumeSeed } from '@/lib/web-chat-resume-seed'
import { translate } from '@/i18n/i18n'

// Why: 재개 대상은 오르카 기본 에이전트(settings.defaultTuiAgent)를 따른다.
// blank/null/비활성/native-chat 미지원이면 재개 불가 → null(UI가 비활성+힌트).
export function resolveWebChatResumeAgent(
  defaultTuiAgent: TuiAgent | 'blank' | null,
  disabledTuiAgents: readonly TuiAgent[]
): TuiAgent | null {
  if (!defaultTuiAgent || defaultTuiAgent === 'blank') {
    return null
  }
  if (!isTuiAgentEnabled(defaultTuiAgent, disabledTuiAgents)) {
    return null
  }
  if (!isNativeChatSupportedAgent(defaultTuiAgent)) {
    return null
  }
  return defaultTuiAgent
}

// Why: 웹 대화를 chats.db에서 읽어 시드 문자열로 만든 뒤, 기존 launchAgentInNewTab의
// submit-after-ready 경로로 로컬 에이전트 새 탭에 paste+submit해 이어가게 한다.
export async function resumeWebChatAsLocalAgent(args: {
  session: Pick<AiVaultSession, 'agent' | 'sessionId' | 'title'>
  agent: TuiAgent
  worktreeId: string
}): Promise<void> {
  const result = await window.api.nativeChat.readSession(args.session.agent, args.session.sessionId)
  if ('error' in result || result.messages.length === 0) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.webChatResumeEmpty',
        '이어갈 대화 내용이 없어요.'
      )
    )
    return
  }
  const seed = buildWebChatResumeSeed(result.messages, args.session.agent as WebChatAgent)
  launchAgentInNewTab({
    agent: args.agent,
    worktreeId: args.worktreeId,
    prompt: seed,
    promptDelivery: 'submit-after-ready',
    launchSource: 'web_chat_resume'
  })
}
