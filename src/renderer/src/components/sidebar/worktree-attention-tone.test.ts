import { describe, expect, it } from 'vitest'
import { getWorktreeAttentionTone } from './worktree-attention-tone'

describe('getWorktreeAttentionTone', () => {
  it('marks a blocked agent as needing the user, read or not', () => {
    expect(getWorktreeAttentionTone('permission', false)).toBe('needs-you')
    expect(getWorktreeAttentionTone('permission', true)).toBe('needs-you')
  })

  it('marks an unread finished turn as done and an unread failure as failed', () => {
    expect(getWorktreeAttentionTone('done', true)).toBe('done')
    expect(getWorktreeAttentionTone('inactive', true)).toBe('done')
    expect(getWorktreeAttentionTone('failed', true)).toBe('failed')
  })

  it('leaves read rows and running agents quiet', () => {
    expect(getWorktreeAttentionTone('done', false)).toBeNull()
    expect(getWorktreeAttentionTone('failed', false)).toBeNull()
    expect(getWorktreeAttentionTone('working', true)).toBeNull()
    expect(getWorktreeAttentionTone('monitoring', true)).toBeNull()
    expect(getWorktreeAttentionTone('active', false)).toBeNull()
  })

  it('does not paint a live shell that rang the bell as done', () => {
    expect(getWorktreeAttentionTone('active', true)).toBeNull()
  })
})
