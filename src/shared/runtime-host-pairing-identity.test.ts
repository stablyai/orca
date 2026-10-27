import { describe, expect, it } from 'vitest'
import { classifyRuntimeHostRePair } from './runtime-host-pairing-identity'

const INSTALL_A = '11111111-1111-4111-8111-111111111111'
const INSTALL_B = '22222222-2222-4222-8222-222222222222'
const BIND_1 = 'a'.repeat(43)
const BIND_2 = 'b'.repeat(43)

describe('classifyRuntimeHostRePair', () => {
  it('treats a different host key as a different server, whatever the descriptor says', () => {
    expect(
      classifyRuntimeHostRePair(
        { publicKeys: ['key-a'], pin: { installationId: INSTALL_A } },
        { publicKeyB64: 'key-b', hostDescriptor: { installationId: INSTALL_A } }
      )
    ).toEqual({ kind: 'different-host' })
  })

  it('keeps an unpinned server matched by key and pins its first descriptor', () => {
    expect(classifyRuntimeHostRePair({ publicKeys: ['key-a'] }, { publicKeyB64: 'key-a' })).toEqual(
      { kind: 'same-host', pin: undefined, descriptor: 'unpinned' }
    )
    expect(
      classifyRuntimeHostRePair(
        { publicKeys: ['key-a'] },
        { publicKeyB64: 'key-a', hostDescriptor: { installationId: INSTALL_A } }
      )
    ).toEqual({ kind: 'same-host', pin: { installationId: INSTALL_A }, descriptor: 'pinned' })
  })

  it('separates a same-key server whose installation changed', () => {
    expect(
      classifyRuntimeHostRePair(
        { publicKeys: ['key-a'], pin: { installationId: INSTALL_A } },
        { publicKeyB64: 'key-a', hostDescriptor: { installationId: INSTALL_B } }
      )
    ).toEqual({ kind: 'different-host' })
  })

  it('keeps a moved or reinstalled server and re-pins its new binding', () => {
    const next = { installationId: INSTALL_A, machineBinding: BIND_2 }
    expect(
      classifyRuntimeHostRePair(
        { publicKeys: ['key-a'], pin: { installationId: INSTALL_A, machineBinding: BIND_1 } },
        { publicKeyB64: 'key-a', hostDescriptor: next }
      )
    ).toEqual({ kind: 'same-host', pin: next, descriptor: 'moved' })
  })

  it('does not call a macOS host moved when an upgrade first adds its binding, or a downgrade drops it', () => {
    // Older Orca read no macOS machine id, so its descriptor carried no binding (#29259).
    const unbound = { installationId: INSTALL_A }
    const bound = { installationId: INSTALL_A, machineBinding: BIND_1 }
    expect(
      classifyRuntimeHostRePair(
        { publicKeys: ['key-a'], pin: unbound },
        { publicKeyB64: 'key-a', hostDescriptor: bound }
      )
    ).toEqual({ kind: 'same-host', pin: bound, descriptor: 'pinned' })
    expect(
      classifyRuntimeHostRePair(
        { publicKeys: ['key-a'], pin: bound },
        { publicKeyB64: 'key-a', hostDescriptor: unbound }
      )
    ).toEqual({ kind: 'same-host', pin: unbound, descriptor: 'pinned' })
  })

  it('never learns from a downgraded server that stopped sending a descriptor', () => {
    const pin = { installationId: INSTALL_A, machineBinding: BIND_1 }
    expect(
      classifyRuntimeHostRePair({ publicKeys: ['key-a'], pin }, { publicKeyB64: 'key-a' })
    ).toEqual({ kind: 'same-host', pin, descriptor: 'unverifiable' })
  })
})
