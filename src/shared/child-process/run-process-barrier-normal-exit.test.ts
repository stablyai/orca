import { describe, expect, it } from 'vitest'
import { runProcess } from './run-process'

/** The barrier's whole promise is that no descendant outlived the gate. A clean
 *  exit code says nothing about the tree, so the root closing on its own was
 *  reported as UNVERIFIED — which made every normally-completing required gate
 *  record a FAIL and left no admitted outcome able to complete. */
describe.skipIf(process.platform === 'win32')('a barrier verifies a normal exit too', () => {
  it('reports verified termination when the root exits on its own', async () => {
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', 'exit 0'],
      terminationBarrier: true
    })

    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.terminationVerified).toBe(true)
  })

  it('still reports verified when the command fails on its own terms', async () => {
    // A non-zero exit is the GATE failing, not the barrier. The tree is gone
    // either way, and conflating the two hides which one actually happened.
    const result = await runProcess({
      program: '/bin/sh',
      args: ['-c', 'exit 3'],
      terminationBarrier: true
    })

    expect(result.code).toBe(3)
    expect(result.terminationVerified).toBe(true)
  })
})
