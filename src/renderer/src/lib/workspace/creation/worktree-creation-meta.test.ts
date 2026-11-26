import { beforeEach, describe, expect, it, vi } from 'vitest'
import { persistCreationMetadata } from './worktree-creation-meta'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values: Record<string, string> = {}) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name] ?? '')
}))

describe('persistCreationMetadata', () => {
  beforeEach(() => {
    toastError.mockClear()
  })

  it('writes the trimmed note and normalized tags as separate updates', async () => {
    const write = vi.fn(async () => ({ ok: true as const }))
    await persistCreationMetadata({
      worktreeId: 'wt',
      workspaceName: 'feature',
      note: '  fix login  ',
      tags: ['billing team', 'Billing Team', 'api'],
      write
    })

    expect(write).toHaveBeenCalledWith('wt', { comment: 'fix login' })
    expect(write).toHaveBeenCalledWith('wt', { tags: ['billing team', 'api'] })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('keeps the note when the host refuses tags, and says so', async () => {
    const write = vi.fn(async (_id: string, updates: Record<string, unknown>) =>
      'tags' in updates
        ? { ok: false as const, error: 'Update the remote runtime to tag workspaces' }
        : { ok: true as const }
    )
    await persistCreationMetadata({
      worktreeId: 'wt',
      workspaceName: 'feature',
      note: 'fix login',
      tags: ['billing'],
      write
    })

    expect(write).toHaveBeenCalledWith('wt', { comment: 'fix login' })
    expect(toastError).toHaveBeenCalledWith(
      'feature was created, but its note or tags could not be saved',
      { description: 'Update the remote runtime to tag workspaces' }
    )
  })

  it('writes nothing when there is nothing to save', async () => {
    const write = vi.fn(async () => ({ ok: true as const }))
    await persistCreationMetadata({
      worktreeId: 'wt',
      workspaceName: 'x',
      note: ' ',
      tags: [],
      write
    })
    expect(write).not.toHaveBeenCalled()
  })
})
