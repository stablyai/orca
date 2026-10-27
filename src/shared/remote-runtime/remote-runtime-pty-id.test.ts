import { describe, expect, it } from 'vitest'
import { isRemoteRuntimePtyId, parseRemoteRuntimePtyId } from './remote-runtime-pty-id'
import { getPtyExecutionHost } from '../terminal-execution-host'

describe('isRemoteRuntimePtyId', () => {
  // Pins the merge of the prefix-only and parse-based copies: an unparseable `remote:` id still
  // runs off this host, matching getPtyExecutionHost's 'foreign' verdict.
  it('treats an unparseable remote id as remote, never local', () => {
    const malformed = 'remote:%E0%A4%A@@handle'
    expect(parseRemoteRuntimePtyId(malformed)).toBeNull()
    expect(isRemoteRuntimePtyId(malformed)).toBe(true)
    expect(getPtyExecutionHost(malformed)).toBe('foreign')
  })
})
