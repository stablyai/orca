import { describe, expect, it } from 'vitest'
import { CreateTerminalTab } from './session-tabs-schemas-params'

const SESSION = { key: 'session_id', id: 'codex-1' }

describe('session.tabs.createTerminal resumeProviderSession', () => {
  it('carries the conversation a resume names', () => {
    const parsed = CreateTerminalTab.parse({
      worktree: 'id:wt',
      launchAgent: 'codex',
      resumeProviderSession: SESSION
    })
    expect(parsed.resumeProviderSession).toEqual(SESSION)
  })

  it('drops a malformed value instead of refusing the create', () => {
    const parsed = CreateTerminalTab.parse({
      worktree: 'id:wt',
      resumeProviderSession: { key: 'thread', id: '' }
    })
    expect(parsed.resumeProviderSession).toBeUndefined()
  })

  it('refuses it on a fork, which uses the host launch settings', () => {
    const parsed = CreateTerminalTab.safeParse({
      worktree: 'id:wt',
      sourceChatFork: { sessionId: 'chat-1' },
      clientMutationId: 'fork-1',
      resumeProviderSession: SESSION
    })
    expect(parsed.success).toBe(false)
  })
})
