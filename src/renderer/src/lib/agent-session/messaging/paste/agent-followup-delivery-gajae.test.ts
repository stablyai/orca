import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pasteDraftToAgentPtyWhenReady } from '@/lib/agent-session/messaging/paste/agent-paste-draft'
import { inspectRuntimeTerminalProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { TUI_AGENT_CONFIG } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import { sendFollowupPromptWhenAgentReady } from './agent-followup-delivery'

vi.mock('@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn()
}))
vi.mock('@/lib/agent-session/messaging/paste/agent-paste-draft', () => ({
  pasteDraftToAgentPtyWhenReady: vi.fn()
}))

describe('gajae-code follow-up readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(pasteDraftToAgentPtyWhenReady).mockResolvedValue(true)
  })

  it('accepts a gajae-code foreground when the launch expected process is gjc', async () => {
    vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
      foregroundProcess: 'gajae-code',
      hasChildProcesses: true
    })

    const delivered = await sendFollowupPromptWhenAgentReady({
      ptyId: 'pty-1',
      agent: 'gajae-code',
      expectedProcess: TUI_AGENT_CONFIG['gajae-code'].expectedProcess,
      prompt: 'ship it'
    })

    expect(delivered).toBe(true)
    expect(pasteDraftToAgentPtyWhenReady).toHaveBeenCalledWith(
      expect.objectContaining({
        ptyId: 'pty-1',
        content: 'ship it',
        agent: 'gajae-code',
        submit: true,
        forcePaste: true
      })
    )
  })
})
