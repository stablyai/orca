import { expect, it } from 'vitest'
import { parsePtyOwnershipTransferPrepareResult } from './pty-ownership-transfer-wire-results'

const result = {
  version: 1,
  phase: 'prepared',
  bridgeId: 'bridge',
  terminalId: 'pty',
  incarnationId: 'incarnation',
  ownerLease: 'lease',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'runtime',
  sourceOutputEndSeq: 0,
  replayStartSeq: 1,
  surfacePublication: {
    version: 1,
    surfaceBinding: {
      executionHostId: 'local',
      workspaceKey: 'folder:folder',
      tabId: 'tab',
      leafId: '11111111-1111-4111-8111-111111111111',
      ptyId: 'pty'
    }
  },
  destinationDelegation: { version: 1, credentialSha256: 'a'.repeat(64) }
}
it('retains validated optional delegation evidence without retaining peer references', () => {
  const parsed = parsePtyOwnershipTransferPrepareResult(result)
  expect(parsed.destinationDelegation).toEqual(result.destinationDelegation)
  expect(parsed.destinationDelegation).not.toBe(result.destinationDelegation)
})
it('keeps ordinary and older preparation replies valid without delegation', () => {
  expect(
    parsePtyOwnershipTransferPrepareResult({ ...result, destinationDelegation: undefined })
  ).not.toHaveProperty('destinationDelegation')
  expect(
    parsePtyOwnershipTransferPrepareResult({
      ...result,
      destinationDelegation: undefined,
      surfacePublication: undefined
    })
  ).not.toHaveProperty('surfacePublication')
})
it.each([
  { destinationDelegation: { version: 1, credentialSha256: 'invalid' } },
  { destinationDelegation: { version: 2, credentialSha256: 'a'.repeat(64) } },
  { surfacePublication: undefined }
])('rejects invalid delegation evidence %j', (patch) => {
  expect(() => parsePtyOwnershipTransferPrepareResult({ ...result, ...patch })).toThrow()
})
