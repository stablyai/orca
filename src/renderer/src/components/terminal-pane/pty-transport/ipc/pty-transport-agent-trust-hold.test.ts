import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installIpcPtyWindow, restorePtySpecWindow } from './pty-transport-test-harness'

const prompt = vi.hoisted(() => ({ answer: vi.fn() }))

vi.mock('../../../agent-workspace-trust/agent-workspace-trust-decision-prompt', () => ({
  awaitAgentWorkspaceTrustDecision: prompt.answer
}))

const CLAUDE_LAUNCH = {
  worktreeId: 'repo-1::/repos/app',
  launchAgent: 'claude',
  command: 'claude'
} as const

describe('createIpcPtyTransport: first-launch agent trust answer', () => {
  const originalWindow: typeof window | undefined = globalThis.window

  beforeEach(() => {
    vi.resetModules()
    prompt.answer.mockReset()
    installIpcPtyWindow(originalWindow, {})
  })

  afterEach(() => {
    restorePtySpecWindow(originalWindow)
  })

  async function connectClaude(): Promise<unknown> {
    const { createIpcPtyTransport } = await import('./pty-transport')
    return createIpcPtyTransport(CLAUDE_LAUNCH).connect({ url: '', callbacks: {} })
  }

  it('spawns only after the answer, carrying "let agents ask" to main for this launch', async () => {
    let answer: (value: 'agent-asks' | 'pre-trust' | null) => void = () => {}
    prompt.answer.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))

    const { createIpcPtyTransport } = await import('./pty-transport')
    const connecting = createIpcPtyTransport(CLAUDE_LAUNCH).connect({ url: '', callbacks: {} })
    await vi.waitFor(() => expect(prompt.answer).toHaveBeenCalled())
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    answer('agent-asks')
    await connecting

    expect(vi.mocked(window.api.pty.spawn).mock.calls[0]?.[0]).toMatchObject({
      skipAgentWorkspaceTrust: true
    })
  })

  it('reattaches a section terminal without asking or changing trust', async () => {
    const { createIpcPtyTransport } = await import('./pty-transport')
    await createIpcPtyTransport({
      ...CLAUDE_LAUNCH,
      worktreeId: 'folder:placement',
      trustWorktreeId: CLAUDE_LAUNCH.worktreeId
    }).connect({ url: '', callbacks: {}, sessionId: 'existing-pty' })

    expect(prompt.answer).not.toHaveBeenCalled()
    expect(vi.mocked(window.api.pty.spawn).mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'existing-pty',
      worktreeId: 'folder:placement',
      trustWorktreeId: CLAUDE_LAUNCH.worktreeId
    })
    expect(vi.mocked(window.api.pty.spawn).mock.calls[0]?.[0]).not.toHaveProperty(
      'skipAgentWorkspaceTrust'
    )
  })

  it("spawns with today's default when the prompt is released without an answer", async () => {
    prompt.answer.mockResolvedValueOnce(null)

    await connectClaude()

    expect(vi.mocked(window.api.pty.spawn).mock.calls[0]?.[0]).not.toHaveProperty(
      'skipAgentWorkspaceTrust'
    )
  })
})
