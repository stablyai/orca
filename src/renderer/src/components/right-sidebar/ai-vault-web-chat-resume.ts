import { toast } from 'sonner'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../shared/types'
import type { AiVaultAgent, AiVaultSession, WebChatAgent } from '../../../../shared/ai-vault-types'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { launchAiVaultSessionInNewTab } from '@/lib/launch-ai-vault-session'
import { buildAiVaultResumeStartupForWorktree } from '@/lib/ai-vault-resume-command'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { buildWebChatResumeSeed } from '@/lib/web-chat-resume-seed'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

// 지원 타겟(v1). claude=진짜 변환, codex=시드. openclaude/agy/gemini는 후속.
export const WEB_CHAT_RESUME_AGENTS = ['claude', 'codex'] as const

// Why: 재개 타겟은 기본 에이전트(settings.defaultTuiAgent)가 지원타겟이면 그것.
// blank/null/비활성/미지원이면 null(UI가 Claude/Codex 선택 프롬프트로 대체).
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
  return (WEB_CHAT_RESUME_AGENTS as readonly string[]).includes(defaultTuiAgent)
    ? defaultTuiAgent
    : null
}

function seedResume(
  args: { session: Pick<AiVaultSession, 'agent'>; agent: TuiAgent; worktreeId: string },
  messages: NativeChatMessage[]
): void {
  const seed = buildWebChatResumeSeed(messages, args.session.agent as WebChatAgent)
  launchAgentInNewTab({
    agent: args.agent,
    worktreeId: args.worktreeId,
    prompt: seed,
    promptDelivery: 'submit-after-ready',
    launchSource: 'web_chat_resume'
  })
}

// Why: claude만 진짜 변환(claude --resume). 웹 대화를 Claude 세션 파일로 쓰고,
// 기존 로컬 resume 경로(buildAiVaultResumeStartupForWorktree)를 합성 세션으로 재사용해
// SSH/WSL/Windows 셸 해석까지 로컬 세션과 동일하게 처리한다. 그 외(codex)는 시드.
export async function resumeWebChatWithAgent(args: {
  session: Pick<AiVaultSession, 'agent' | 'sessionId' | 'title'>
  agent: TuiAgent
  worktreeId: string
  cwd: string
  gitBranch: string | null
}): Promise<void> {
  const read = await window.api.nativeChat.readSession(args.session.agent, args.session.sessionId)
  if ('error' in read || read.messages.length === 0) {
    toast.error(
      translate(
        'auto.components.right.sidebar.AiVaultPanel.webChatResumeEmpty',
        '이어갈 대화 내용이 없어요.'
      )
    )
    return
  }
  if (args.agent === 'claude') {
    const state = useAppStore.getState()
    const host = parseExecutionHostId(getExecutionHostIdForWorktree(state, args.worktreeId))
    // Why: 세션 파일은 로컬 ~/.claude에 쓰지만 원격(SSH/runtime) 워크트리에선 원격 claude가
    // 그 파일을 못 찾는다. 시드는 원격에서도 동작하므로 원격 호스트는 시드로 이어간다.
    if (host?.kind === 'ssh' || host?.kind === 'runtime') {
      seedResume(args, read.messages)
      return
    }
    const written = await window.api.nativeChat.writeWebChatClaudeSession({
      messages: read.messages,
      cwd: args.cwd,
      gitBranch: args.gitBranch
    })
    if ('error' in written) {
      // 변환 실패(권한/버전 등) → 시드로 폴백.
      seedResume(args, read.messages)
      return
    }
    const startup = buildAiVaultResumeStartupForWorktree({
      state,
      worktreeId: args.worktreeId,
      // Why: 방금 쓴 세션을 로컬 claude 세션처럼 취급 — cwd는 세션 파일을 쓴 cwd와
      // 동일해야 claude --resume이 <slug>/<id>.jsonl을 찾는다.
      session: { agent: 'claude', sessionId: written.sessionId, cwd: args.cwd, codexHome: null }
    })
    launchAiVaultSessionInNewTab({
      agent: 'claude' as Exclude<AiVaultAgent, WebChatAgent>,
      worktreeId: args.worktreeId,
      command: startup.command,
      ...(startup.env ? { env: startup.env } : {}),
      ...(startup.launchConfig ? { launchConfig: startup.launchConfig } : {})
    })
    return
  }
  // codex 등 → 시드
  seedResume(args, read.messages)
}
