import { expect, it } from 'vitest'
import { parsePtyOwnershipTransferTerminalInfo } from './pty-ownership-transfer-terminal-info'
import { parsePtyOwnershipTransferDestinationStatus } from './pty-ownership-transfer-destination-status'

const info = { pid: 42, cols: 80, rows: 24, initialCwd: '/srv/work' }
it('preserves a source-recorded handle while accepting older sources without one', () => {
  expect(
    parsePtyOwnershipTransferTerminalInfo({ ...info, terminalHandle: 'term_original' })
  ).toEqual({
    ...info,
    terminalHandle: 'term_original'
  })
  expect(parsePtyOwnershipTransferTerminalInfo(info)).not.toHaveProperty('terminalHandle')
})
it.each(['', 'other', 'term_bad\0', 7, null])(
  'refuses invalid handle evidence %s',
  (terminalHandle) => {
    expect(() => parsePtyOwnershipTransferTerminalInfo({ ...info, terminalHandle })).toThrow()
  }
)
it('copies only host terminal fields', () => {
  expect(parsePtyOwnershipTransferTerminalInfo({ ...info, unexpected: 'ignored' })).toEqual(info)
  expect(Object.isFrozen(parsePtyOwnershipTransferTerminalInfo(info))).toBe(true)
})
it.each([{ pid: 0 }, { cols: -1 }, { rows: 0.5 }, { initialCwd: '' }, { initialCwd: 'bad\0path' }])(
  'refuses invalid host metadata %#',
  (patch) => {
    expect(() => parsePtyOwnershipTransferTerminalInfo({ ...info, ...patch })).toThrow()
  }
)
const status = {
  version: 1,
  bridgeId: 'bridge',
  terminalId: 'terminal',
  incarnationId: 'incarnation',
  ownerLease: 'lease',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'runtime',
  phase: 'prepared',
  destinationClaim: { generation: 1, claimId: 'claim' },
  boundToConnection: true,
  executionVerdict: 'live'
}
it('keeps missing old-host metadata absent', () => {
  expect(parsePtyOwnershipTransferDestinationStatus(status)).not.toHaveProperty('terminalInfo')
  expect(
    parsePtyOwnershipTransferDestinationStatus({ ...status, terminalInfo: info }).terminalInfo
  ).toEqual(info)
})
it.each([
  { boundToConnection: false },
  { executionVerdict: 'unverifiable' },
  { executionVerdict: undefined }
])('refuses metadata without active live source evidence %#', (patch) => {
  expect(() =>
    parsePtyOwnershipTransferDestinationStatus({ ...status, ...patch, terminalInfo: info })
  ).toThrow()
})
