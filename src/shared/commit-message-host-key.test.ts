import { describe, expect, it } from 'vitest'
import {
  LOCAL_COMMIT_MESSAGE_HOST_KEY,
  RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX,
  UNKNOWN_COMMIT_MESSAGE_HOST_KEY,
  getCommitMessageModelDiscoveryHostKey,
  getCommitMessageModelDiscoveryHostKeyForScope
} from './commit-message-host-key'

describe('commit message host-key sentinels', () => {
  it('locks the three exported sentinel values', () => {
    expect(LOCAL_COMMIT_MESSAGE_HOST_KEY).toBe('local')
    expect(UNKNOWN_COMMIT_MESSAGE_HOST_KEY).toBe('unknown')
    expect(RUNTIME_COMMIT_MESSAGE_HOST_KEY_PREFIX).toBe('runtime:')
  })
})

describe('getCommitMessageModelDiscoveryHostKey', () => {
  it('maps an undefined connection id to the unknown key', () => {
    expect(getCommitMessageModelDiscoveryHostKey(undefined)).toBe(UNKNOWN_COMMIT_MESSAGE_HOST_KEY)
  })

  it('maps a null or empty connection id to the local key', () => {
    expect(getCommitMessageModelDiscoveryHostKey(null)).toBe(LOCAL_COMMIT_MESSAGE_HOST_KEY)
    expect(getCommitMessageModelDiscoveryHostKey('')).toBe(LOCAL_COMMIT_MESSAGE_HOST_KEY)
  })

  it('prefixes a non-empty connection id as an ssh key', () => {
    expect(getCommitMessageModelDiscoveryHostKey('conn-1')).toBe('ssh:conn-1')
  })

  it('treats a "0" connection id as present, not empty', () => {
    // Why: a "0" string is falsy-free here — only null/'' collapse to LOCAL.
    expect(getCommitMessageModelDiscoveryHostKey('0')).toBe('ssh:0')
  })
})

describe('getCommitMessageModelDiscoveryHostKeyForScope', () => {
  it('maps an undefined scope to the unknown key', () => {
    expect(getCommitMessageModelDiscoveryHostKeyForScope(undefined)).toBe(
      UNKNOWN_COMMIT_MESSAGE_HOST_KEY
    )
  })

  it('maps a null or empty scope to the local key', () => {
    expect(getCommitMessageModelDiscoveryHostKeyForScope(null)).toBe(LOCAL_COMMIT_MESSAGE_HOST_KEY)
    expect(getCommitMessageModelDiscoveryHostKeyForScope('')).toBe(LOCAL_COMMIT_MESSAGE_HOST_KEY)
  })

  it('passes a runtime-prefixed scope through unchanged', () => {
    expect(getCommitMessageModelDiscoveryHostKeyForScope('runtime:foo')).toBe('runtime:foo')
    expect(getCommitMessageModelDiscoveryHostKeyForScope('runtime:')).toBe('runtime:')
  })

  it('requires the runtime prefix at the start, not merely contained in the scope', () => {
    // Why: startsWith (not includes) is the contract — a non-leading 'runtime:' routes to ssh:.
    expect(getCommitMessageModelDiscoveryHostKeyForScope('foo:runtime:bar')).toBe(
      'ssh:foo:runtime:bar'
    )
  })

  it('does not treat the bare "runtime" token without a colon as a runtime scope', () => {
    // Why: the colon is part of the prefix; without it the scope is an ordinary ssh id.
    expect(getCommitMessageModelDiscoveryHostKeyForScope('runtime')).toBe('ssh:runtime')
  })

  it('delegates a non-runtime scope to the connection-id resolver as an ssh key', () => {
    expect(getCommitMessageModelDiscoveryHostKeyForScope('conn-1')).toBe('ssh:conn-1')
  })

  it('does not treat the literal "local" string as the local sentinel', () => {
    // Why: only null/'' collapse to LOCAL; a truthy scope routes through the ssh: resolver.
    expect(getCommitMessageModelDiscoveryHostKeyForScope('local')).toBe('ssh:local')
  })
})
