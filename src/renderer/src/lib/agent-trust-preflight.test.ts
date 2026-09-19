import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { preflightAgentTrust } from './agent-trust-preflight'

const markTrusted = vi.fn()

describe('preflightAgentTrust', () => {
  beforeEach(() => {
    markTrusted.mockReset().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { agentTrust: { markTrusted } } })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('marks a trust-gated agent with the host connection id', async () => {
    await preflightAgentTrust({ agent: 'codex', workspacePath: '/repo/wt', connectionId: 'ssh-1' })

    expect(markTrusted).toHaveBeenCalledWith({
      preset: 'codex',
      workspacePath: '/repo/wt',
      connectionId: 'ssh-1'
    })
  })

  it('omits a null connection id for local workspaces', async () => {
    await preflightAgentTrust({ agent: 'codex', workspacePath: '/repo/wt', connectionId: null })

    expect(markTrusted).toHaveBeenCalledWith({ preset: 'codex', workspacePath: '/repo/wt' })
  })

  it.each([
    ['no agent', { agent: null, workspacePath: '/repo/wt' }],
    ['no workspace path yet', { agent: 'codex' as const, workspacePath: null }],
    ['an empty workspace path', { agent: 'codex' as const, workspacePath: '' }]
  ])('skips the mark with %s', async (_label, args) => {
    await preflightAgentTrust(args)

    expect(markTrusted).not.toHaveBeenCalled()
  })

  it('skips agents without a trust preset', async () => {
    await preflightAgentTrust({ agent: 'aider', workspacePath: '/repo/wt' })

    expect(markTrusted).not.toHaveBeenCalled()
  })

  it('swallows a failed best-effort mark', async () => {
    markTrusted.mockRejectedValue(new Error('offline'))

    await expect(
      preflightAgentTrust({ agent: 'codex', workspacePath: '/repo/wt' })
    ).resolves.toBeUndefined()
  })

  it('is a no-op when the bridge is unavailable', async () => {
    vi.stubGlobal('window', { api: {} })

    await expect(
      preflightAgentTrust({ agent: 'codex', workspacePath: '/repo/wt' })
    ).resolves.toBeUndefined()
  })
})
