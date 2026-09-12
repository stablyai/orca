import { describe, expect, it } from 'vitest'
import {
  PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION,
  type PtyOwnershipBridgeCapabilities,
  type PtyOwnershipBridgeHello
} from './pty-ownership-bridge-contract'
import {
  isPtyOwnershipBridgeCapabilities,
  parsePtyOwnershipBridgeCapabilities,
  PtyOwnershipBridge,
  PtyOwnershipBridgeError
} from './pty-ownership-bridge'

const capabilities = (
  overrides: Partial<PtyOwnershipBridgeCapabilities> = {}
): PtyOwnershipBridgeCapabilities => ({
  protocolVersions: [PTY_OWNERSHIP_BRIDGE_PROTOCOL_VERSION],
  maxReplayBytes: 64,
  maxInputIds: 32,
  inputDeduplication: true,
  rollback: true,
  liveTransfer: true,
  destinationOutput: true,
  destinationControl: true,
  authoritativeExit: true,
  ...overrides
})

const hello = (overrides: Partial<PtyOwnershipBridgeHello> = {}): PtyOwnershipBridgeHello => ({
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  capabilities: capabilities(),
  ...overrides
})
it.each([
  'preparationShutdownGuardVersion',
  'transferGraceGuardVersion',
  'transferLifecycleGuardVersion'
] as const)('negotiates exact %s only for enabled live transfer', (key) => {
  for (const version of [undefined, null, false, '1', 0, 2]) {
    expect(
      parsePtyOwnershipBridgeCapabilities({
        ...capabilities(),
        [key]: version
      })
    ).not.toHaveProperty(key)
  }
  expect(parsePtyOwnershipBridgeCapabilities(capabilities({ [key]: 1 }))).toHaveProperty(key, 1)
  expect(
    parsePtyOwnershipBridgeCapabilities(
      capabilities({
        [key]: 1,
        liveTransfer: false
      })
    )
  ).not.toHaveProperty(key)
})
it('accepts capture recovery only with its authenticated delegation and selection prerequisites', () => {
  const supported = capabilities({
    destinationDelegationVersion: 1,
    captureBoundaryVersion: 1,
    captureSelectionVersion: 1,
    captureSelectionRecoveryVersion: 1
  })
  expect(parsePtyOwnershipBridgeCapabilities(supported)).toHaveProperty(
    'captureSelectionRecoveryVersion',
    1
  )
  for (const key of [
    'destinationDelegationVersion',
    'captureBoundaryVersion',
    'captureSelectionVersion',
    'captureSelectionRecoveryVersion'
  ] as const) {
    expect(
      parsePtyOwnershipBridgeCapabilities({ ...supported, [key]: undefined })
    ).not.toHaveProperty('captureSelectionRecoveryVersion')
  }
  expect(
    parsePtyOwnershipBridgeCapabilities({ ...supported, liveTransfer: false })
  ).not.toHaveProperty('captureSelectionRecoveryVersion')
  expect(
    parsePtyOwnershipBridgeCapabilities({ ...supported, captureSelectionRecoveryVersion: 2 })
  ).not.toHaveProperty('captureSelectionRecoveryVersion')
})

it.each([
  'sourceRetirementVersion',
  'sourceRetirementBoundaryVersion',
  'sourceRetirementRecoveryVersion'
] as const)('retains only supported exact source retirement capability %s', (key) => {
  const supported = capabilities({
    destinationDelegationVersion: 1,
    sourceRetirementVersion: 1,
    sourceRetirementBoundaryVersion: 1,
    sourceRetirementRecoveryVersion: 1
  })
  expect(parsePtyOwnershipBridgeCapabilities(supported)).toHaveProperty(key, 1)
  expect(Object.isFrozen(parsePtyOwnershipBridgeCapabilities(supported))).toBe(true)
  for (const version of [undefined, null, false, '1', 0, 2]) {
    expect(
      parsePtyOwnershipBridgeCapabilities({ ...supported, [key]: version })
    ).not.toHaveProperty(key)
  }
  for (const unsupported of [
    { liveTransfer: false },
    { destinationDelegationVersion: undefined },
    { sourceRetirementVersion: undefined }
  ]) {
    expect(
      parsePtyOwnershipBridgeCapabilities({ ...supported, ...unsupported })
    ).not.toHaveProperty(key)
  }
  expect(parsePtyOwnershipBridgeCapabilities(capabilities())).not.toHaveProperty(key)
})

function createBridge(options: Parameters<typeof PtyOwnershipBridge.negotiate>[2] = {}) {
  const bridge = PtyOwnershipBridge.negotiate(hello(), hello(), {
    createBridgeId: () => 'bridge-1',
    ...options
  })
  if (!bridge) {
    throw new Error('expected bridge negotiation to succeed')
  }
  return bridge
}

describe('PtyOwnershipBridge', () => {
  it('recognizes delegated preparation only with explicit supported version and live mutation', () => {
    expect(
      parsePtyOwnershipBridgeCapabilities(capabilities({ destinationDelegationVersion: 1 }))
    ).toHaveProperty('destinationDelegationVersion', 1)
    for (const version of [undefined, 0, 2, true, '1']) {
      expect(
        parsePtyOwnershipBridgeCapabilities({
          ...capabilities(),
          destinationDelegationVersion: version
        })
      ).not.toHaveProperty('destinationDelegationVersion')
    }
    expect(
      parsePtyOwnershipBridgeCapabilities(
        capabilities({ liveTransfer: false, destinationDelegationVersion: 1 })
      )
    ).not.toHaveProperty('destinationDelegationVersion')
  })
  it('requires both supported capture capabilities before enabling selection', () => {
    expect(
      parsePtyOwnershipBridgeCapabilities(
        capabilities({ captureBoundaryVersion: 1, captureSelectionVersion: 1 })
      )
    ).toMatchObject({ captureBoundaryVersion: 1, captureSelectionVersion: 1 })
    for (const version of [undefined, 0, 2, true, '1']) {
      expect(
        parsePtyOwnershipBridgeCapabilities({
          ...capabilities(),
          captureBoundaryVersion: 1,
          captureSelectionVersion: version
        })
      ).not.toHaveProperty('captureSelectionVersion')
      expect(
        parsePtyOwnershipBridgeCapabilities({
          ...capabilities(),
          captureBoundaryVersion: version,
          captureSelectionVersion: 1
        })
      ).not.toHaveProperty('captureSelectionVersion')
    }
  })
  it('recognizes only the supported optional source capture version', () => {
    expect(
      parsePtyOwnershipBridgeCapabilities(capabilities({ captureBoundaryVersion: 1 }))
    ).toMatchObject({ captureBoundaryVersion: 1 })
    for (const version of [undefined, 0, 2, true, '1']) {
      const decoded = parsePtyOwnershipBridgeCapabilities({
        ...capabilities(),
        captureBoundaryVersion: version
      })
      expect(decoded).not.toBeNull()
      expect(decoded).not.toHaveProperty('captureBoundaryVersion')
    }
  })

  it('decodes capability responses at the wire boundary and rejects malformed peers', () => {
    const response = capabilities({ liveTransfer: false, reconnectRekey: true })
    const decoded = parsePtyOwnershipBridgeCapabilities(response)

    expect(decoded).toEqual(response)
    expect(decoded).not.toBe(response)
    expect(isPtyOwnershipBridgeCapabilities(decoded)).toBe(true)
    expect(parsePtyOwnershipBridgeCapabilities({ ...response, protocolVersions: [] })).toBeNull()
    expect(parsePtyOwnershipBridgeCapabilities({ ...response, maxReplayBytes: 0 })).toBeNull()
    expect(
      parsePtyOwnershipBridgeCapabilities({ ...response, inputDeduplication: 'true' })
    ).toBeNull()
    expect(parsePtyOwnershipBridgeCapabilities(undefined)).toBeNull()
  })

  it('negotiates only when both endpoints support the protocol and safety features', () => {
    expect(createBridge().grant).toMatchObject({
      protocolVersion: 1,
      bridgeId: 'bridge-1',
      terminalId: 'terminal-1',
      replayBytes: 64,
      inputIds: 32,
      inputDeduplication: true,
      rollback: true,
      liveTransfer: true,
      destinationOutput: true
    })
    expect(
      PtyOwnershipBridge.negotiate(
        hello({ capabilities: capabilities({ protocolVersions: [2] }) }),
        hello()
      )
    ).toBeNull()
    expect(
      PtyOwnershipBridge.negotiate(
        hello({ capabilities: capabilities({ inputDeduplication: false }) }),
        hello()
      )
    ).toBeNull()
    expect(
      PtyOwnershipBridge.negotiate(
        hello({ capabilities: capabilities({ liveTransfer: false }) }),
        hello()
      )
    ).toBeNull()
    expect(
      PtyOwnershipBridge.negotiate(
        hello({ capabilities: capabilities({ destinationOutput: false }) }),
        hello()
      )
    ).toBeNull()
  })

  it('negotiates reconnect rekey only when both endpoints advertise it', () => {
    const supported = capabilities({ postCommitReplay: true, reconnectRekey: true })
    const withoutRekey = capabilities({ postCommitReplay: true })

    expect(
      PtyOwnershipBridge.negotiate(
        hello({ capabilities: supported }),
        hello({ capabilities: supported })
      )?.grant
    ).toMatchObject({ postCommitReplay: true, reconnectRekey: true })
    expect(
      PtyOwnershipBridge.negotiate(
        hello({ capabilities: supported }),
        hello({ capabilities: withoutRekey })
      )?.grant
    ).not.toHaveProperty('reconnectRekey')
  })

  it('stages interleaved output and commits exactly once after destination catches up', () => {
    const bridge = createBridge()
    bridge.prepare('source')
    const first = bridge.appendOutput('source', 'one')
    const second = bridge.appendOutput('source', 'two')
    bridge.acceptOutput('destination', first)
    bridge.acceptOutput('destination', second)

    expect(bridge.snapshot()).toMatchObject({
      phase: 'prepared',
      sourceOutputEndSeq: 2,
      destinationOutputEndSeq: 2,
      stagedOutputFrames: 2
    })
    expect(bridge.commit('destination')).toEqual([first, second])
    expect(bridge.commit('destination')).toEqual([first, second])
    expect(() => bridge.appendOutput('source', 'late')).toThrow(
      expect.objectContaining({ reason: 'invalid-phase' })
    )
  })

  it('rejects gaps, retains a bounded replay window, and reports unavailable checkpoints', () => {
    const bridge = createBridge({ replayBytes: 5 })
    const first = bridge.appendOutput('source', '1234')
    const second = bridge.appendOutput('source', '567890')
    bridge.prepare('source')
    expect(() => bridge.acceptOutput('destination', second)).toThrow(
      expect.objectContaining({ reason: 'output-gap' })
    )
    bridge.acceptOutput('destination', first)
    bridge.acceptOutput('destination', second)
    expect(bridge.snapshot().retainedReplayBytes).toBe(5)
    expect(() => bridge.replayAfter('source', 0)).toThrow(
      expect.objectContaining({ reason: 'replay-unavailable' })
    )
    expect(() => bridge.replayAfter('source', 1)).toThrow(
      expect.objectContaining({ reason: 'replay-unavailable' })
    )
  })

  it('deduplicates input across a disconnect and rejects changed duplicate IDs', () => {
    const bridge = createBridge()
    bridge.prepare('source')
    bridge.appendOutput('source', 'ready')
    bridge.acceptOutput('destination', bridge.replayAfter('source', 0)[0])
    bridge.commit('destination')
    const writes: string[] = []
    expect(
      bridge.acceptInput('destination', { inputId: 'input-1', data: 'ls\n' }, (data) =>
        writes.push(data)
      )
    ).toEqual({
      accepted: true,
      duplicate: false
    })
    expect(
      bridge.acceptInput('destination', { inputId: 'input-1', data: 'ls\n' }, (data) =>
        writes.push(data)
      )
    ).toEqual({
      accepted: false,
      duplicate: true
    })
    expect(writes).toEqual(['ls\n'])
    expect(() =>
      bridge.acceptInput('destination', { inputId: 'input-1', data: 'whoami\n' }, () => {})
    ).toThrow(expect.objectContaining({ reason: 'input-conflict' }))
    expect(bridge.retireInputIds('destination', ['input-1', 'input-missing'])).toBe(1)
    expect(
      bridge.acceptInput('destination', { inputId: 'input-1', data: 'whoami\n' }, (data) =>
        writes.push(data)
      )
    ).toEqual({ accepted: true, duplicate: false })
  })

  it('rolls back a prepared transfer without publishing staged output', () => {
    const bridge = createBridge()
    bridge.prepare('source')
    const frame = bridge.appendOutput('source', 'not-visible-yet')
    bridge.acceptOutput('destination', frame)
    bridge.abort('destination')

    expect(bridge.snapshot()).toMatchObject({ phase: 'aborted', stagedOutputFrames: 0 })
    expect(bridge.appendOutput('source', 'source-keeps-running')).toMatchObject({ seq: 2 })
    expect(bridge.prepare('source').phase).toBe('prepared')
    expect(() => bridge.commit('destination')).toThrow(PtyOwnershipBridgeError)
    expect(() =>
      bridge.acceptInput('destination', { inputId: 'input-1', data: 'x' }, () => {})
    ).toThrow(expect.objectContaining({ reason: 'invalid-phase' }))
  })

  it('fails closed on identity mismatches instead of creating a second owner', () => {
    expect(() =>
      PtyOwnershipBridge.negotiate(hello(), hello({ ownerLease: 'different-lease' }))
    ).toThrow(expect.objectContaining({ reason: 'identity-mismatch' }))
  })
})
