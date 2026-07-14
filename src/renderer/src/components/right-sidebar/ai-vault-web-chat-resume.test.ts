import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const launchAgentInNewTabSpy = vi.fn()
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: (a: unknown) => launchAgentInNewTabSpy(a)
}))

const launchAiVaultSessionInNewTabSpy = vi.fn()
vi.mock('@/lib/launch-ai-vault-session', () => ({
  launchAiVaultSessionInNewTab: (a: unknown) => launchAiVaultSessionInNewTabSpy(a)
}))

const buildAiVaultResumeStartupForWorktreeSpy = vi.fn((_args: unknown): { command: string } => ({
  command: 'cd /w && claude --resume SID'
}))
vi.mock('@/lib/ai-vault-resume-command', () => ({
  buildAiVaultResumeStartupForWorktree: (a: unknown) => buildAiVaultResumeStartupForWorktreeSpy(a)
}))

const mockState = {}
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockState
  }
}))

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (m: unknown) => toastError(m), success: vi.fn() } }))

import { resolveWebChatResumeAgent, resumeWebChatWithAgent } from './ai-vault-web-chat-resume'

type StubReadMessage = {
  id: string
  role: string
  blocks: { type: string; text: string }[]
  timestamp: number
  source: string
}
type StubReadSessionResult = { messages: StubReadMessage[] } | { error: string }
type StubWriteSessionResult = { sessionId: string } | { error: string }

const readSessionStub = vi.fn(
  async (): Promise<StubReadSessionResult> => ({
    messages: [
      {
        id: 'm0',
        role: 'user',
        blocks: [{ type: 'text', text: '안녕' }],
        timestamp: 0,
        source: 'transcript'
      }
    ]
  })
)
const writeWebChatClaudeSessionStub = vi.fn(
  async (): Promise<StubWriteSessionResult> => ({ sessionId: 'written-session-id' })
)

beforeEach(() => {
  launchAgentInNewTabSpy.mockClear()
  launchAiVaultSessionInNewTabSpy.mockClear()
  buildAiVaultResumeStartupForWorktreeSpy.mockClear()
  toastError.mockClear()
  readSessionStub.mockClear()
  writeWebChatClaudeSessionStub.mockClear()
  readSessionStub.mockImplementation(async () => ({
    messages: [
      {
        id: 'm0',
        role: 'user',
        blocks: [{ type: 'text', text: '안녕' }],
        timestamp: 0,
        source: 'transcript'
      }
    ]
  }))
  writeWebChatClaudeSessionStub.mockImplementation(async () => ({
    sessionId: 'written-session-id'
  }))
  ;(globalThis as { window?: unknown }).window = {
    api: {
      nativeChat: {
        readSession: readSessionStub,
        writeWebChatClaudeSession: writeWebChatClaudeSessionStub
      }
    }
  }
})
afterEach(() => vi.clearAllMocks())

test('resolveWebChatResumeAgent: 지원 타겟(claude/codex)만 통과', () => {
  expect(resolveWebChatResumeAgent('claude', [])).toBe('claude')
  expect(resolveWebChatResumeAgent('codex', [])).toBe('codex')
  expect(resolveWebChatResumeAgent('gemini', [])).toBeNull() // 지원타겟 아님
  expect(resolveWebChatResumeAgent('blank', [])).toBeNull()
  expect(resolveWebChatResumeAgent(null, [])).toBeNull()
  expect(resolveWebChatResumeAgent('claude', ['claude'])).toBeNull() // 비활성
})

test('resumeWebChatWithAgent(claude): 세션 변환 후 buildAiVaultResumeStartupForWorktree로 재개', async () => {
  await resumeWebChatWithAgent({
    session: { agent: 'claude-web', sessionId: 'c_1', title: 'T' },
    agent: 'claude',
    worktreeId: 'w1',
    cwd: '/w/1',
    gitBranch: 'main'
  })
  expect(readSessionStub).toHaveBeenCalledWith('claude-web', 'c_1')
  expect(writeWebChatClaudeSessionStub).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: '/w/1', gitBranch: 'main' })
  )
  expect(buildAiVaultResumeStartupForWorktreeSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      worktreeId: 'w1',
      session: expect.objectContaining({
        agent: 'claude',
        sessionId: 'written-session-id',
        cwd: '/w/1'
      })
    })
  )
  expect(launchAiVaultSessionInNewTabSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'claude',
      worktreeId: 'w1',
      command: expect.stringContaining('resume')
    })
  )
  expect(launchAgentInNewTabSpy).not.toHaveBeenCalled()
})

test('resumeWebChatWithAgent(codex): 시드로 launchAgentInNewTab 호출, 변환 경로는 미호출', async () => {
  await resumeWebChatWithAgent({
    session: { agent: 'gemini-web', sessionId: 'c_1', title: 'T' },
    agent: 'codex',
    worktreeId: 'w1',
    cwd: '/w/1',
    gitBranch: null
  })
  expect(launchAgentInNewTabSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'codex',
      worktreeId: 'w1',
      promptDelivery: 'submit-after-ready',
      launchSource: 'web_chat_resume',
      prompt: expect.stringContaining('Gemini에서')
    })
  )
  expect(writeWebChatClaudeSessionStub).not.toHaveBeenCalled()
  expect(launchAiVaultSessionInNewTabSpy).not.toHaveBeenCalled()
})

test('resumeWebChatWithAgent: readSession 에러면 launch 안 하고 toast', async () => {
  readSessionStub.mockImplementation(async () => ({ error: 'boom' }))
  await resumeWebChatWithAgent({
    session: { agent: 'gemini-web', sessionId: 'c_1', title: 'T' },
    agent: 'claude',
    worktreeId: 'w1',
    cwd: '/w/1',
    gitBranch: null
  })
  expect(writeWebChatClaudeSessionStub).not.toHaveBeenCalled()
  expect(launchAiVaultSessionInNewTabSpy).not.toHaveBeenCalled()
  expect(launchAgentInNewTabSpy).not.toHaveBeenCalled()
  expect(toastError).toHaveBeenCalled()
})

test('resumeWebChatWithAgent: readSession 빈 대화면 launch 안 하고 toast', async () => {
  readSessionStub.mockImplementation(async () => ({ messages: [] }))
  await resumeWebChatWithAgent({
    session: { agent: 'gemini-web', sessionId: 'c_1', title: 'T' },
    agent: 'claude',
    worktreeId: 'w1',
    cwd: '/w/1',
    gitBranch: null
  })
  expect(launchAgentInNewTabSpy).not.toHaveBeenCalled()
  expect(toastError).toHaveBeenCalled()
})

test('resumeWebChatWithAgent(claude): 변환 실패면 시드로 폴백', async () => {
  writeWebChatClaudeSessionStub.mockImplementation(async () => ({ error: 'write failed' }))
  await resumeWebChatWithAgent({
    session: { agent: 'claude-web', sessionId: 'c_1', title: 'T' },
    agent: 'claude',
    worktreeId: 'w1',
    cwd: '/w/1',
    gitBranch: null
  })
  expect(launchAiVaultSessionInNewTabSpy).not.toHaveBeenCalled()
  expect(launchAgentInNewTabSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      agent: 'claude',
      worktreeId: 'w1',
      promptDelivery: 'submit-after-ready',
      launchSource: 'web_chat_resume'
    })
  )
})
