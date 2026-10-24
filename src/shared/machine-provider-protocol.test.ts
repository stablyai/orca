import { describe, expect, it } from 'vitest'
import {
  MachineProviderError,
  isConfirmedMachineTransition,
  parseMachineProviderResponse,
  type MachineProviderRequest
} from './machine-provider-protocol'

const NOW = '2026-10-18T12:00:00Z'
const FINGERPRINT = `SHA256:${'A'.repeat(43)}`
const SSH_ACCESS = {
  kind: 'ssh',
  host: 'omarchy',
  port: 42200,
  user: 'dev',
  projectRoot: '/home/dev/src',
  hostKeyFingerprints: [FINGERPRINT]
}

function request(overrides: Partial<MachineProviderRequest> = {}): MachineProviderRequest {
  return { protocolVersion: 1, operationId: 'op-1', verb: 'get', machineId: 'm-1', ...overrides }
}

function machine(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'm-1',
    name: 'dev',
    lifetime: 'persistent',
    state: 'running',
    createdAt: NOW,
    access: SSH_ACCESS,
    ...overrides
  }
}

function respond(body: Record<string, unknown>, envelope: Record<string, unknown> = {}): string {
  return JSON.stringify({ protocolVersion: 1, operationId: 'op-1', now: NOW, ...envelope, ...body })
}

function errorCode(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    if (error instanceof MachineProviderError) {
      return error.code
    }
    throw error
  }
  throw new Error('expected a MachineProviderError')
}

function accessWith(overrides: Record<string, unknown>): Record<string, unknown> {
  return { access: { ...SSH_ACCESS, ...overrides } }
}

describe('parseMachineProviderResponse', () => {
  it('accepts a running machine with pinned host keys and strips unknown envelope keys', () => {
    const response = parseMachineProviderResponse(
      respond({ kind: 'machine', machine: machine({ futureField: 1 }) }, { extra: true }),
      request()
    )
    expect(response).toMatchObject({ kind: 'machine', machine: { id: 'm-1', state: 'running' } })
    expect(response).not.toHaveProperty('extra')
  })

  it.each([
    ['a host that starts with "-"', accessWith({ host: '-oProxyCommand=x' })],
    ['whitespace in user', accessWith({ user: 'dev x' })],
    ['a control character in jumpHost', accessWith({ jumpHost: 'a\u0007b' })],
    ['a relative projectRoot', accessWith({ projectRoot: 'src' })],
    ['a proxyCommand', accessWith({ proxyCommand: 'nc %h %p' })],
    ['a malformed fingerprint', accessWith({ hostKeyFingerprints: ['MD5:aa'] })],
    ['a host key with a trailing comment', accessWith({ hostKeys: ['ssh-ed25519 AAAA x@y'] })],
    ['a host key option line', accessWith({ hostKeys: ['@cert-authority * ssh-ed25519 AAAA'] })],
    ['access while sleeping', { state: 'sleeping' }],
    ['an unknown lifetime', { lifetime: 'long-lived' }],
    ['an id with shell metacharacters', { id: 'm;1' }]
  ])('rejects %s', (_label, overrides) => {
    expect(
      errorCode(() =>
        parseMachineProviderResponse(
          respond({ kind: 'machine', machine: machine(overrides) }),
          request({ machineId: typeof overrides.id === 'string' ? overrides.id : 'm-1' })
        )
      )
    ).toBe('invalid-response')
  })

  it('rejects duplicate ids and oversize inventories', () => {
    const list = request({ verb: 'list', machineId: undefined })
    expect(
      errorCode(() =>
        parseMachineProviderResponse(
          respond({ kind: 'inventory', machines: [machine(), machine()] }),
          list
        )
      )
    ).toBe('invalid-response')
    const many = Array.from({ length: 257 }, (_, index) =>
      machine({ id: `m-${index}`, state: 'sleeping', access: undefined })
    )
    expect(
      errorCode(() =>
        parseMachineProviderResponse(respond({ kind: 'inventory', machines: many }), list)
      )
    ).toBe('invalid-response')
  })

  it('requires the operationId echo, the requested machine, and the matching kind', () => {
    expect(
      errorCode(() =>
        parseMachineProviderResponse(
          respond({ kind: 'machine', machine: machine() }, { operationId: 'other' }),
          request()
        )
      )
    ).toBe('invalid-response')
    expect(
      errorCode(() =>
        parseMachineProviderResponse(
          respond({ kind: 'machine', machine: machine({ id: 'm-2' }) }),
          request()
        )
      )
    ).toBe('invalid-response')
    expect(
      errorCode(() =>
        parseMachineProviderResponse(
          respond({ kind: 'inventory', machines: [] }),
          request({ verb: 'get' })
        )
      )
    ).toBe('invalid-response')
  })

  it('fails closed when the provider answers for a different account', () => {
    const withContext = request({ contextId: 'omarchy:neil' })
    expect(
      errorCode(() =>
        parseMachineProviderResponse(
          respond({ kind: 'machine', machine: machine() }, { contextId: 'omarchy:other' }),
          withContext
        )
      )
    ).toBe('context-mismatch')
    expect(
      errorCode(() =>
        parseMachineProviderResponse(respond({ kind: 'machine', machine: machine() }), withContext)
      )
    ).toBe('context-mismatch')
    // A not-found from another account would mark machines gone, so it fails closed too.
    expect(
      errorCode(() =>
        parseMachineProviderResponse(
          respond({ kind: 'error', code: 'not-found', message: 'gone' }),
          withContext
        )
      )
    ).toBe('context-mismatch')
    // Signed-out providers may not know their context, so auth errors pass through.
    expect(
      parseMachineProviderResponse(
        respond({ kind: 'error', code: 'auth-required', message: 'sign in' }),
        withContext
      )
    ).toMatchObject({ kind: 'error', code: 'auth-required' })
  })

  it('maps an unknown error code to unavailable and a newer protocol to protocol-unsupported', () => {
    expect(
      parseMachineProviderResponse(
        respond({ kind: 'error', code: 'rate-limited', message: 'slow down' }),
        request()
      )
    ).toMatchObject({ code: 'unavailable', message: 'slow down' })
    expect(
      errorCode(() =>
        parseMachineProviderResponse(
          respond({ kind: 'machine', machine: machine() }, { protocolVersion: 2 }),
          request()
        )
      )
    ).toBe('protocol-unsupported')
  })

  it('ignores capability verbs and lifetimes this build does not know', () => {
    const response = parseMachineProviderResponse(
      respond({
        kind: 'capabilities',
        capabilities: {
          verbs: ['create', 'teleport', 'wake', 'wake'],
          lifetimes: ['temporary', 'forever']
        }
      }),
      request({ verb: 'capabilities', machineId: undefined })
    )
    expect(response).toMatchObject({
      capabilities: { verbs: ['create', 'wake'], lifetimes: ['temporary'] }
    })
  })

  it('rejects JSON that exceeds the depth limit', () => {
    let nested: unknown = 'x'
    for (let depth = 0; depth < 20; depth++) {
      nested = { nested }
    }
    expect(
      errorCode(() =>
        parseMachineProviderResponse(
          respond({ kind: 'machine', machine: machine({ detail: nested }) }),
          request()
        )
      )
    ).toBe('invalid-response')
  })
})

describe('isConfirmedMachineTransition', () => {
  it('requires each lifecycle verb to report its target state', () => {
    expect(isConfirmedMachineTransition('wake', 'running')).toBe(true)
    expect(isConfirmedMachineTransition('wake', 'waking')).toBe(true)
    expect(isConfirmedMachineTransition('wake', 'sleeping')).toBe(false)
    expect(isConfirmedMachineTransition('sleep', 'sleeping')).toBe(true)
    expect(isConfirmedMachineTransition('sleep', 'running')).toBe(false)
    expect(isConfirmedMachineTransition('archive', 'archived')).toBe(true)
    expect(isConfirmedMachineTransition('delete', 'running')).toBe(false)
    expect(isConfirmedMachineTransition('delete', 'unknown')).toBe(true)
  })
})
