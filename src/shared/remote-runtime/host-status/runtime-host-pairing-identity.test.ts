import { describe, expect, it } from 'vitest'
import { classifyRuntimeHostRePair } from './runtime-host-pairing-identity'

const INSTALL_A = '11111111-1111-4111-8111-111111111111'
const INSTALL_B = '22222222-2222-4222-8222-222222222222'
const BIND_1 = 'a'.repeat(43)

describe('classifyRuntimeHostRePair', () => {
  it('treats a different host key as a different server, whatever the descriptor says', () => {
    expect(
      classifyRuntimeHostRePair(
        { publicKeys: ['key-a'], pin: { installationId: INSTALL_A } },
        { publicKeyB64: 'key-b', hostDescriptor: { installationId: INSTALL_A } }
      )
    ).toEqual({ kind: 'different-host' })
  })

  it('separates a same-key server whose installation changed', () => {
    expect(
      classifyRuntimeHostRePair(
        { publicKeys: ['key-a'], pin: { installationId: INSTALL_A } },
        { publicKeyB64: 'key-a', hostDescriptor: { installationId: INSTALL_B } }
      )
    ).toEqual({ kind: 'different-host' })
  })

  it('never learns from a downgraded server that stopped sending a descriptor', () => {
    const pin = { installationId: INSTALL_A, machineBinding: BIND_1 }
    expect(
      classifyRuntimeHostRePair({ publicKeys: ['key-a'], pin }, { publicKeyB64: 'key-a' })
    ).toEqual({ kind: 'same-host', pin, descriptor: 'unverifiable' })
  })
})
