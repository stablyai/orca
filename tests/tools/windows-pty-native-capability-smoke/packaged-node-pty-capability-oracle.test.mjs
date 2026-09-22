import { describe, expect, it } from 'vitest'
import { evaluatePackagedNodePtyCapability } from './packaged-node-pty-capability-oracle.mjs'

const fixtureToken = 'a'.repeat(64)
const channel = `\\\\.\\pipe\\orca-pty-native-capability-${fixtureToken}`

function observation(pid, role) {
  return { pid, fixtureToken, role, channel }
}

function closure(role) {
  return { fixtureToken, role, channel }
}

function passingEvidence() {
  const shell = observation(4100, 'target-shell')
  const launcherExited = observation(4101, 'target-launcher-exited')
  const grandchild = observation(4102, 'target-grandchild')
  const canary = observation(5100, 'canary-shell')
  return {
    patchedExports: ['assignCurrentProcessToJob', 'listJobProcessIds', 'terminateJob'],
    fixtureToken,
    channel,
    target: {
      terminalHandle: 'pty-job:7:4100',
      shell,
      launcherExited,
      grandchild,
      jobProcessIds: [shell.pid, grandchild.pid]
    },
    canary: {
      terminalHandle: 'pty-job:8:5100',
      process: canary,
      connectedAfterTargetClose: true,
      jobProcessIdsAfterTargetClose: [canary.pid],
      exit: { terminalHandle: 'pty-job:8:5100', exitCode: 1, signal: 0 },
      socketClosed: closure('canary-shell')
    },
    close: {
      method: 'terminate-job',
      requestedHandle: 'pty-job:7:4100',
      completedHandle: 'pty-job:7:4100',
      targetExit: { terminalHandle: 'pty-job:7:4100', exitCode: 1, signal: 0 },
      targetShellClosed: closure('target-shell'),
      targetGrandchildClosed: closure('target-grandchild')
    }
  }
}

describe('packaged node-pty native capability oracle', () => {
  it('accepts exact target teardown while the unrelated canary remains live', () => {
    expect(evaluatePackagedNodePtyCapability(passingEvidence())).toEqual({
      pass: true,
      failures: []
    })
  })

  it.each([
    ['missing patched export', (evidence) => evidence.patchedExports.pop()],
    ['launcher exit absent', (evidence) => delete evidence.target.launcherExited],
    ['empty job membership', (evidence) => (evidence.target.jobProcessIds = [])],
    [
      'target shell outside membership',
      (evidence) => (evidence.target.jobProcessIds = [evidence.target.grandchild.pid])
    ],
    [
      'launcher-surviving grandchild outside membership',
      (evidence) => (evidence.target.jobProcessIds = [evidence.target.shell.pid])
    ],
    ['target exit absent', (evidence) => delete evidence.close.targetExit],
    ['canary connection loss', (evidence) => (evidence.canary.connectedAfterTargetClose = false)]
  ])('rejects %s', (_name, mutate) => {
    const evidence = passingEvidence()
    mutate(evidence)

    expect(evaluatePackagedNodePtyCapability(evidence).pass).toBe(false)
  })

  it.each([
    ['guessable token', (evidence) => (evidence.fixtureToken = 'run-1')],
    [
      'grandchild from another channel',
      (evidence) => (evidence.target.grandchild.channel = '\\\\.\\pipe\\other')
    ],
    ['wrong completed handle', (evidence) => (evidence.close.completedHandle = 'pty-job:9:9999')],
    [
      'launcher still in target job',
      (evidence) => evidence.target.jobProcessIds.push(evidence.target.launcherExited.pid)
    ],
    ['canary outside its job', (evidence) => (evidence.canary.jobProcessIdsAfterTargetClose = [])],
    ['canary teardown absent', (evidence) => delete evidence.canary.socketClosed]
  ])('rejects scope violation: %s', (_name, mutate) => {
    const evidence = passingEvidence()
    mutate(evidence)

    expect(evaluatePackagedNodePtyCapability(evidence).pass).toBe(false)
  })
})
