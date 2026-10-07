import { afterEach, describe, expect, it } from 'vitest'
import { setSpawnObserver } from './spawn-observer'
import { runProcess, spawnProcess } from './run-process'

afterEach(() => {
  setSpawnObserver(null)
})

describe('spawn observer', () => {
  it('reports the resolved program for a spawnProcess child', async () => {
    const seen: { command: string; args: readonly string[]; blockMs: number }[] = []
    setSpawnObserver((command, args, blockMs) => seen.push({ command, args, blockMs }))
    const child = spawnProcess({ program: process.execPath, args: ['-e', 'process.exit(0)'] })
    await new Promise((resolve) => child.on('exit', resolve))
    expect(seen).toHaveLength(1)
    expect(seen[0].command).toBe(process.execPath)
    expect(seen[0].args).toEqual(['-e', 'process.exit(0)'])
    expect(seen[0].blockMs).toBeGreaterThanOrEqual(0)
  })

  it('reports exactly once for runProcess, which spawns through spawnProcess', async () => {
    let calls = 0
    setSpawnObserver(() => {
      calls += 1
    })
    await runProcess({ program: process.execPath, args: ['-e', 'process.exit(0)'] })
    expect(calls).toBe(1)
  })

  it('stays silent with no observer registered', async () => {
    let calls = 0
    setSpawnObserver(null)
    await runProcess({ program: process.execPath, args: ['-e', 'process.exit(0)'] })
    setSpawnObserver(() => {
      calls += 1
    })
    expect(calls).toBe(0)
  })
})
