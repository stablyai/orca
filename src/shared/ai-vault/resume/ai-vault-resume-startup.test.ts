import { describe, expect, it } from 'vitest'
import { resolveAiVaultCopiedSessionAgentArgs } from './ai-vault-resume-startup'

describe('OpenCode 1 copies of OpenCode 2 chats', () => {
  it('drops OpenCode 2 private-server mode flags', () => {
    expect(
      resolveAiVaultCopiedSessionAgentArgs({
        session: { agent: 'opencode', sessionId: 'ses_x', cwd: 'C:\\t' },
        host: { platform: 'win32', codexHome: null, liveShell: 'posix' },
        settings: null,
        sourceAgent: 'opencode2'
      })
    ).toBe('')
  })

  it('keeps other source launch mode tokens', () => {
    expect(
      resolveAiVaultCopiedSessionAgentArgs({
        session: { agent: 'opencode', sessionId: 'ses_x', cwd: 'C:\\t' },
        host: { platform: 'win32', codexHome: null, liveShell: 'posix' },
        settings: null,
        sourceAgent: 'omp'
      })
    ).toBe('')
  })
})
