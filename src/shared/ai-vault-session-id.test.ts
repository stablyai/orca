import { describe, expect, it } from 'vitest'
import { buildAiVaultSessionId } from './ai-vault-session-id'

const base = {
  executionHostId: 'local' as const,
  sessionId: 'abc123',
  filePath: '/home/ada/.claude/projects/repo/abc123.jsonl'
}

describe('buildAiVaultSessionId', () => {
  it('appends the file path for non-cursor agents', () => {
    expect(buildAiVaultSessionId({ ...base, agent: 'claude' })).toBe(
      'local:claude:abc123:/home/ada/.claude/projects/repo/abc123.jsonl'
    )
  })

  it('omits the file path for cursor so bucket moves keep session identity', () => {
    expect(buildAiVaultSessionId({ ...base, agent: 'cursor' })).toBe('local:cursor:abc123')
  })

  it('adds a context hash when the storage context differs from the execution host', () => {
    const id = buildAiVaultSessionId({
      ...base,
      agent: 'cursor',
      cursorStorageContextKey: 'wsl:Ubuntu'
    })
    expect(id).toMatch(/^local:cursor:abc123:ctx-[0-9a-f]{16}$/)
    expect(id).toBe(
      buildAiVaultSessionId({ ...base, agent: 'cursor', cursorStorageContextKey: 'wsl:Ubuntu' })
    )
  })

  it('skips the context hash for native storage and for the execution host itself', () => {
    expect(
      buildAiVaultSessionId({ ...base, agent: 'cursor', cursorStorageContextKey: 'native' })
    ).toBe('local:cursor:abc123')
    expect(
      buildAiVaultSessionId({ ...base, agent: 'cursor', cursorStorageContextKey: 'local' })
    ).toBe('local:cursor:abc123')
  })

  it('tags bucket collisions and prefers them over legacy path collisions', () => {
    expect(
      buildAiVaultSessionId({
        ...base,
        agent: 'cursor',
        cursorBucketCollision: 'deadbeef',
        cursorLegacyPathCollision: '/home/ada/.cursor/chats/deadbeef'
      })
    ).toBe('local:cursor:abc123:bucket-deadbeef')
    expect(
      buildAiVaultSessionId({
        ...base,
        agent: 'cursor',
        cursorLegacyPathCollision: '/home/ada/.cursor/chats/deadbeef'
      })
    ).toMatch(/^local:cursor:abc123:legacy-[0-9a-f]{16}$/)
  })

  it('preserves the suffix of a previous id so rescans keep the same row identity', () => {
    expect(
      buildAiVaultSessionId({
        ...base,
        agent: 'cursor',
        previousId: 'local:cursor:abc123:ctx-0123456789abcdef:bucket-deadbeef',
        cursorBucketCollision: 'cafebabe'
      })
    ).toBe('local:cursor:abc123:ctx-0123456789abcdef:bucket-deadbeef')
  })

  it('reads the last session-id marker when the session id repeats in the previous id', () => {
    expect(
      buildAiVaultSessionId({
        ...base,
        agent: 'cursor',
        previousId: 'ssh:box:cursor:abc123:cursor:abc123:bucket-deadbeef'
      })
    ).toBe('local:cursor:abc123:bucket-deadbeef')
  })

  it('ignores a previous id whose suffix is not a recognized identity marker', () => {
    expect(
      buildAiVaultSessionId({
        ...base,
        agent: 'cursor',
        previousId: 'local:cursor:abc123:/home/ada/.cursor/chats/deadbeef/abc123/meta.json'
      })
    ).toBe('local:cursor:abc123')
  })

  it('ignores a previous id recorded for a different session', () => {
    expect(
      buildAiVaultSessionId({
        ...base,
        agent: 'cursor',
        previousId: 'local:cursor:other:bucket-deadbeef'
      })
    ).toBe('local:cursor:abc123')
  })
})
