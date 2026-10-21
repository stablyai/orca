import { describe, expect, it } from 'vitest'
import {
  isRemoteRuntimePtyId,
  parseRemoteRuntimePtyId,
  toRemoteRuntimePtyId
} from './remote-runtime-pty-id'
import { getPtyExecutionHost } from './terminal-execution-host'

describe('isRemoteRuntimePtyId', () => {
  it('recognizes minted paired-runtime ids, with and without an owner', () => {
    expect(isRemoteRuntimePtyId(toRemoteRuntimePtyId('h1', 'env 1'))).toBe(true)
    expect(isRemoteRuntimePtyId(toRemoteRuntimePtyId('h1'))).toBe(true)
  })

  it('rejects local, SSH and missing ids', () => {
    expect(isRemoteRuntimePtyId('pty-1')).toBe(false)
    expect(isRemoteRuntimePtyId('ssh:conn@@pty-1')).toBe(false)
    expect(isRemoteRuntimePtyId('')).toBe(false)
    expect(isRemoteRuntimePtyId(null)).toBe(false)
    expect(isRemoteRuntimePtyId(undefined)).toBe(false)
  })

  // Pins the merge of the prefix-only and parse-based copies: an unparseable `remote:` id still
  // runs off this host, matching getPtyExecutionHost's 'foreign' verdict.
  it('treats an unparseable remote id as remote, never local', () => {
    const malformed = 'remote:%E0%A4%A@@handle'
    expect(parseRemoteRuntimePtyId(malformed)).toBeNull()
    expect(isRemoteRuntimePtyId(malformed)).toBe(true)
    expect(getPtyExecutionHost(malformed)).toBe('foreign')
  })
})
