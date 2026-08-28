import { beforeEach, describe, expect, it, vi } from 'vitest'
import { warnIfConfiguredClaudeProxy } from './claude-launch-proxy-notice'

const warning = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { warning } }))

describe('warnIfConfiguredClaudeProxy', () => {
  beforeEach(() => warning.mockClear())

  it('explains the configured proxy for Claude launches', () => {
    warnIfConfiguredClaudeProxy('claude', { httpProxyUrl: 'http://127.0.0.1:9' })
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'target host is routed through it unless covered by its bypass rules'
      ),
      {
        duration: 12_000
      }
    )
  })

  it('does not warn for agents without a configured proxy', () => {
    warnIfConfiguredClaudeProxy('codex', { httpProxyUrl: 'http://127.0.0.1:9' })
    warnIfConfiguredClaudeProxy('claude', {})
    expect(warning).not.toHaveBeenCalled()
  })

  it('does not warn for an invalid proxy URL that cannot be injected into the PTY', () => {
    warnIfConfiguredClaudeProxy('claude', { httpProxyUrl: 'not-a-proxy-url' })
    expect(warning).not.toHaveBeenCalled()
  })
})
