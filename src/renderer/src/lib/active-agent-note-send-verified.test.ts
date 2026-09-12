import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sendPromptWithGuardedPasteAndEnter } from './active-agent-note-send-delivery'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: rpc,
  RuntimeRpcCallError: class extends Error {}
}))
vi.mock('./agent-paste-draft', () => ({
  BRACKETED_PASTE_BEGIN: '\x1b[200~',
  BRACKETED_PASTE_END: '\x1b[201~',
  POST_PASTE_SUBMIT_DELAY_MS: 50
}))

const targets = [{ kind: 'local' }, { kind: 'environment', environmentId: 'paired-host' }] as const

describe('verified note delivery', () => {
  beforeEach(() => {
    rpc.mockReset()
  })

  it.each(targets)('submits one complete large prompt on its owning runtime %j', async (target) => {
    let finish: (() => void) | undefined
    rpc.mockImplementation(async (_target, method) => {
      if (method === 'terminal.agentStatus') {
        return {
          agentStatus: { isRunningAgent: true, status: 'idle', supportsGuardedAgentPrompt: true }
        }
      }
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return { send: { accepted: true } }
    })
    const prompt = 'Review this file\n'.repeat(500)
    let settled = false
    const send = sendPromptWithGuardedPasteAndEnter(target, 'term-owner', prompt, {
      allowLegacyFallback: false
    }).then((result) => {
      settled = true
      return result
    })
    await vi.waitFor(() => expect(finish).toBeDefined())
    expect(settled).toBe(false)
    finish!()
    await expect(send).resolves.toEqual({ status: 'sent' })
    const sends = rpc.mock.calls.filter((call) => call[1] === 'terminal.send')
    expect(sends).toEqual([
      [
        target,
        'terminal.send',
        {
          terminal: 'term-owner',
          text: prompt,
          enter: true,
          agentPrompt: true,
          requireAgentStatus: 'sendable',
          client: { id: 'orca-desktop', type: 'desktop' }
        },
        { timeoutMs: 15000 }
      ]
    ])
  })

  it('does not paste again or claim success after an ambiguous verified send', async () => {
    rpc
      .mockResolvedValueOnce({
        agentStatus: { isRunningAgent: true, status: 'idle', supportsGuardedAgentPrompt: true }
      })
      .mockRejectedValueOnce(new Error('agent_prompt_stalled'))
    await expect(
      sendPromptWithGuardedPasteAndEnter(targets[0], 'term-owner', 'review', {
        allowLegacyFallback: false
      })
    ).resolves.toEqual({ status: 'partial-submit-failed', code: 'submit-send-error' })
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('refuses permission prompts before writing', async () => {
    rpc.mockResolvedValue({
      agentStatus: { isRunningAgent: true, status: 'permission', supportsGuardedAgentPrompt: true }
    })
    await expect(
      sendPromptWithGuardedPasteAndEnter(targets[0], 'term-owner', 'review', {
        allowLegacyFallback: false
      })
    ).resolves.toMatchObject({ status: 'permission' })
    expect(rpc).toHaveBeenCalledTimes(1)
  })
})
