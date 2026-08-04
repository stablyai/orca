import { describe, expect, it } from 'vitest'
import {
  FILESYSTEM_HOST_MAX_TEXT_BYTES,
  filesystemHostChildMessageSchema,
  filesystemHostParentMessageSchema
} from './filesystem-host-protocol'

describe('filesystem host protocol', () => {
  it('accepts only typed domain operations', () => {
    expect(
      filesystemHostParentMessageSchema.safeParse({
        type: 'request',
        requestId: 'request-1',
        operation: { kind: 'read-file', path: '/tmp/secret' }
      }).success
    ).toBe(false)
    expect(
      filesystemHostParentMessageSchema.safeParse({
        type: 'request',
        requestId: 'request-1',
        operation: {
          kind: 'read-orca-yaml',
          path: '/tmp/orca.yaml',
          maxBytes: FILESYSTEM_HOST_MAX_TEXT_BYTES + 1
        }
      }).success
    ).toBe(false)
    expect(
      filesystemHostParentMessageSchema.safeParse({
        type: 'request',
        requestId: 'request-1',
        operation: {
          kind: 'read-snapshot-file',
          path: '/tmp/auth.json',
          fileKind: 'arbitrary-secret'
        }
      }).success
    ).toBe(false)
    expect(
      filesystemHostParentMessageSchema.safeParse({
        type: 'request',
        requestId: 'request-1',
        operation: {
          kind: 'resolve-cli-command',
          path: '/home/alice',
          commandName: 'arbitrary-command',
          pathEnvironment: '/usr/bin'
        }
      }).success
    ).toBe(false)
    expect(
      filesystemHostParentMessageSchema.safeParse({
        type: 'request',
        requestId: 'request-1',
        operation: {
          kind: 'resolve-cli-command',
          path: '/home/alice',
          commandName: 'codex',
          pathEnvironment: '/usr/bin'
        }
      }).success
    ).toBe(true)
    expect(
      filesystemHostParentMessageSchema.safeParse({
        type: 'request',
        requestId: 'request-1',
        operation: {
          kind: 'prepare-keybindings',
          path: '/home/alice/.orca/keybindings.json',
          platform: 'linux',
          seedLegacyTabSwitchBindings: true
        }
      }).success
    ).toBe(true)
    expect(
      filesystemHostParentMessageSchema.safeParse({
        type: 'request',
        requestId: 'request-1',
        operation: {
          kind: 'write-rate-limit-credential',
          path: '/home/alice/.gemini/oauth_creds.json',
          fileKind: 'arbitrary-credential',
          contents: '{}'
        }
      }).success
    ).toBe(false)
  })

  it('validates child results before main consumes them', () => {
    expect(
      filesystemHostChildMessageSchema.safeParse({
        type: 'result',
        requestId: 'request-1',
        ok: false,
        error: { code: 'made-up', message: 'bad' }
      }).success
    ).toBe(false)
    expect(
      filesystemHostChildMessageSchema.safeParse({
        type: 'result',
        requestId: 'request-1',
        ok: true,
        result: { kind: 'canonicalize-path', canonicalPath: '/tmp/repo' }
      }).success
    ).toBe(true)
  })

  it('requires a physical worker identity at readiness', () => {
    expect(
      filesystemHostChildMessageSchema.safeParse({ type: 'ready', protocolVersion: 1 }).success
    ).toBe(false)
    expect(
      filesystemHostChildMessageSchema.safeParse({
        type: 'ready',
        protocolVersion: 1,
        workerId: '00000000-0000-4000-8000-000000000001'
      }).success
    ).toBe(true)
  })
})
