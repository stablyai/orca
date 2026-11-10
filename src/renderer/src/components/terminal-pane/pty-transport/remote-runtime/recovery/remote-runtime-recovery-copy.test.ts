import { describe, expect, it } from 'vitest'
import { remoteRuntimeRecoveryCopy } from './remote-runtime-recovery-copy'

describe('reconnect notice copy', () => {
  it('names an Orca Cloud workspace as the person knows it, never its sandbox', () => {
    const copy = remoteRuntimeRecoveryCopy(
      'connection-lost',
      'hello sandbox a062c18e',
      undefined,
      'fix-auth'
    )
    expect(copy.title).toBe('Reconnecting to fix-auth…')
    expect(copy.body).toBe(
      'The connection dropped. Orca is retrying; your files and chats are safe.'
    )
    expect(`${copy.title} ${copy.body}`).not.toContain('a062c18e')
    const other = remoteRuntimeRecoveryCopy(
      'reattaching',
      'hello sandbox a062c18e',
      undefined,
      'fix-auth'
    )
    expect(other.body).toContain('fix-auth')
    expect(other.body).not.toContain('a062c18e')
  })

  it('keeps the server wording for everything else', () => {
    expect(remoteRuntimeRecoveryCopy('connection-lost', 'devbox').title).toBe(
      'Reconnecting to devbox'
    )
  })
})
