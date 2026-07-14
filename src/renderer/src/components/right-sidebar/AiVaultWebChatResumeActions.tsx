import type React from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { TuiAgent } from '../../../../shared/types'
import { aiVaultAgentLabel, type AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { useWorktreeById } from '@/store/selectors'
import { WEB_CHAT_RESUME_AGENTS, resumeWebChatWithAgent } from './ai-vault-web-chat-resume'

// Why: 웹 대화는 읽기전용이지만 지원 에이전트(Claude/Codex)로 이어갈 수 있다. 로컬 세션의
// 재개 어포던스와 같은 결로, 지원 타겟마다 버튼을 하나씩 놓고 기본 에이전트를 강조한다.
// claude=진짜 변환, codex=시드(resumeWebChatWithAgent가 분기).
export function AiVaultWebChatResumeActions({
  session,
  defaultAgent,
  activeWorktreeId
}: {
  session: AiVaultSession
  defaultAgent: TuiAgent | null
  activeWorktreeId: string | null
}): React.JSX.Element {
  // Why: convert-or-seed는 세션 파일을 올바른 프로젝트 디렉토리에 쓰려면 워크트리 cwd/branch가 필요.
  const worktree = useWorktreeById(activeWorktreeId ?? null)
  const disabled = !activeWorktreeId || !worktree
  const hint = disabled
    ? translate(
        'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
        'Open a workspace before resuming a session.'
      )
    : null
  return (
    <>
      {WEB_CHAT_RESUME_AGENTS.map((agent, index) => {
        // 기본 에이전트 강조. 미설정이면 첫 옵션(claude)을 기본 강조해 푸터에 primary 하나는 유지.
        const emphasized = defaultAgent ? agent === defaultAgent : index === 0
        const button = (
          <Button
            type="button"
            variant={emphasized ? 'default' : 'secondary'}
            size="xs"
            disabled={disabled}
            draggable={false}
            onClick={(event) => {
              event.stopPropagation()
              if (activeWorktreeId && worktree) {
                void resumeWebChatWithAgent({
                  session,
                  agent,
                  worktreeId: activeWorktreeId,
                  cwd: worktree.path,
                  gitBranch: worktree.branch || null
                })
              }
            }}
            data-testid={`ai-vault-web-chat-resume-${agent}`}
            className="h-7 shrink-0 px-2.5 text-[11px]"
          >
            <Play className="size-3.5" />
            {translate(
              'auto.components.right.sidebar.AiVaultSessionDetails.resumeWithAgent',
              'Resume with {{value0}}',
              { value0: aiVaultAgentLabel(agent) }
            )}
          </Button>
        )
        if (disabled && hint) {
          return (
            <Tooltip key={agent}>
              <TooltipTrigger asChild>
                <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
                  {button}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {hint}
              </TooltipContent>
            </Tooltip>
          )
        }
        return (
          <span key={agent} className="inline-flex">
            {button}
          </span>
        )
      })}
    </>
  )
}
