import { WEB_CHAT_AGENTS, type WebChatAgent } from './ai-vault-types'

// 소스별 기본 하위폴더 이름 (폴더로 쓰기 좋게 — 'Claude.ai'의 점 회피).
export const WEBCHAT_DEFAULT_SUBDIR: Record<WebChatAgent, string> = {
  chatgpt: 'ChatGPT',
  'claude-web': 'Claude',
  'gemini-web': 'Gemini'
}

// Why: 이 해석기는 렌더러(샌드박스, Node 통합 없음)에서 호출되므로 Node 전용 path 모듈을 못 쓴다.
// workspaceDir의 구분자(Windows \\ vs POSIX /)를 감지해 브라우저-세이프하게 조인한다.
function joinWorkspaceSubdir(workspaceDir: string, subdir: string): string {
  const sep = workspaceDir.includes('\\') ? '\\' : '/'
  const trimmed = workspaceDir.replace(/[\\/]+$/, '')
  return `${trimmed}${sep}${subdir}`
}

// Why: 웹 대화 cwd는 에이전트별 오버라이드, 미지정/빈값이면 workspaceDir 아래 소스 하위폴더.
// 실제 폴더가 없어도 그룹핑 라벨로만 쓰이므로 생성 불필요.
export function resolveWebChatCwdByAgent(
  dirByAgent: Partial<Record<WebChatAgent, string>> | undefined,
  workspaceDir: string
): Record<WebChatAgent, string> {
  const result = {} as Record<WebChatAgent, string>
  for (const agent of WEB_CHAT_AGENTS) {
    const override = dirByAgent?.[agent]
    result[agent] =
      override && override.trim()
        ? override
        : joinWorkspaceSubdir(workspaceDir, WEBCHAT_DEFAULT_SUBDIR[agent])
  }
  return result
}
