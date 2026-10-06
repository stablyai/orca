import { describe, expect, it } from 'vitest'
import { buildRuntimeWorktreeCreateParams } from './worktree-create-payload'

const attempt = { name: 'feature' }

describe('a paired worktree create carries this device starting view (STA-6412)', () => {
  it('sends the startup view as startupViewMode', () => {
    const params = buildRuntimeWorktreeCreateParams(
      {
        repoId: 'repo-1',
        name: 'feature',
        startup: { command: 'claude', viewMode: 'chat' }
      },
      attempt
    )
    expect(params).toMatchObject({ startupCommand: 'claude', startupViewMode: 'chat' })
  })

  it('sends the view of a host-built draft startup', () => {
    const params = buildRuntimeWorktreeCreateParams(
      {
        repoId: 'repo-1',
        name: 'feature',
        options: { startupDraft: 'https://example.test/issue/1', startupViewMode: 'terminal' }
      },
      attempt
    )
    expect(params).toMatchObject({ startupViewMode: 'terminal' })
  })

  it('sends nothing for a create without an agent startup', () => {
    const params = buildRuntimeWorktreeCreateParams({ repoId: 'repo-1', name: 'feature' }, attempt)
    expect(params).not.toHaveProperty('startupViewMode')
  })
})
