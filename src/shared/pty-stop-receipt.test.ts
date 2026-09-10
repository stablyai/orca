import { describe, expect, it } from 'vitest'
import { createPtyStopReceipt, parsePtyStopReceipt } from './pty-stop-receipt'

const INCARNATION = '11111111-1111-4111-8111-111111111111'
const ROOT = {
  pid: 41,
  parentPid: 1,
  processGroupId: 41,
  startedAt: 'Mon Aug 24 08:00:00 2026'
}

function exitedReceipt() {
  return createPtyStopReceipt({
    executionHostId: 'local',
    terminalHandle: 'terminal-1',
    ptyId: 'pty-1',
    ptyIncarnation: INCARNATION,
    root: ROOT,
    descendants: [],
    observations: [{ identity: ROOT, status: 'absent', observedAt: new Date().toISOString() }],
    verdict: 'exited',
    processTreeVerified: true
  })
}

describe('PtyStopReceipt', () => {
  it('accepts an exact verified exit receipt', () => {
    expect(
      parsePtyStopReceipt(exitedReceipt(), {
        executionHostId: 'local',
        terminalHandle: 'terminal-1',
        ptyId: 'pty-1',
        ptyIncarnation: INCARNATION
      })
    ).toMatchObject({ verdict: 'exited', processTreeVerified: true })
  })

  it('rejects reminted terminal identity and incarnation reuse', () => {
    const receipt = exitedReceipt()
    expect(() => parsePtyStopReceipt(receipt, { terminalHandle: 'terminal-2' })).toThrow(
      'pty_stop_receipt_identity_mismatch'
    )
    expect(() =>
      parsePtyStopReceipt(receipt, {
        ptyIncarnation: '22222222-2222-4222-8222-222222222222'
      })
    ).toThrow('pty_stop_receipt_identity_mismatch')
  })

  it('rejects exited when any captured identity remains live', () => {
    expect(() =>
      parsePtyStopReceipt({
        ...exitedReceipt(),
        observations: [{ identity: ROOT, status: 'live', observedAt: new Date().toISOString() }]
      })
    ).toThrow('pty_stop_receipt_exit_unverified')
  })

  it('allows unknown root identity only for capability-limited owners', () => {
    const root = { pid: null, parentPid: null, processGroupId: null, startedAt: null }
    const receipt = createPtyStopReceipt({
      executionHostId: 'ssh:host-1',
      terminalHandle: 'terminal-1',
      ptyId: 'pty-1',
      ptyIncarnation: INCARNATION,
      root,
      descendants: [],
      observations: [
        { identity: root, status: 'unverifiable', observedAt: new Date().toISOString() }
      ],
      verdict: 'capability_limited',
      processTreeVerified: false,
      reason: 'old peer'
    })
    expect(receipt).toMatchObject({ verdict: 'capability_limited', processTreeVerified: false })
  })
})
