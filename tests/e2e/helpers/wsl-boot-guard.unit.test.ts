import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { watchDistroRunning } from './wsl-boot-guard'

const seam = vi.hoisted((): { hold: boolean; pending: null | (() => void) } => ({
  hold: false,
  pending: null
}))
vi.mock('./orca-app', () => ({ expect: {} }))
vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    _args: string[],
    _options: unknown,
    callback: (error: null, stdout: string) => void
  ) => {
    if (seam.hold) {
      seam.pending = () => callback(null, 'Ubuntu\n')
    } else {
      callback(null, 'Ubuntu\n')
    }
  }
}))

it('retains the parsed gap and exact retry refusal after timeout and true stop join', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pr31199-wsl-observer-'))
  const log = join(root, 'spawns.jsonl')
  const initial = { file: 'git', args: ['status'] }
  const gap = {
    file: 'wsl.exe',
    args: ['--list', '--running', '--quiet'],
    at: 123,
    stack: ['gap caller']
  }
  writeFileSync(log, `${JSON.stringify(initial)}\n`)
  // This record appears after the preterminate count and before watcher construction.
  appendFileSync(log, `${JSON.stringify(gap)}\n`)
  vi.useFakeTimers()
  const retryTerminate = vi.fn(async () => {})
  const watcher = watchDistroRunning('Ubuntu', log, { spawnsBefore: 1, retryTerminate })
  const outcome = watcher.stopped.catch((error: unknown) => error)
  let stopping: ReturnType<typeof watcher.stop> | undefined
  try {
    await vi.advanceTimersByTimeAsync(8000)
    seam.hold = true
    await vi.advanceTimersByTimeAsync(2000)
    expect(await outcome).toMatchObject({
      message: 'Ubuntu was still listed 10000 ms after --terminate'
    })
    expect(retryTerminate).not.toHaveBeenCalled()
    let joined = false
    stopping = watcher.stop().then((result) => {
      joined = true
      return result
    })
    await Promise.resolve()
    expect(joined).toBe(false)
    expect(seam.pending).not.toBeNull()
    seam.pending?.()
    await stopping
    const saved = watcher.diagnostics()
    expect(saved).toMatchObject({
      initialStart: 1,
      initialEnd: 2,
      initialGap: [gap],
      finished: true,
      confirmedStopped: false,
      retried: false
    })
    expect(saved.latestRetry).toEqual({
      state: {
        retried: false,
        confirmedStopped: false,
        msSinceTerminate: 10000,
        spawnsSinceTerminate: [gap]
      },
      allowed: false
    })
    appendFileSync(log, `${JSON.stringify({ file: 'new.exe', args: ['later'] })}\n`)
    expect(watcher.diagnostics().latestRetry).toEqual(saved.latestRetry)
    expect(watcher.diagnostics().initialGap).toEqual([gap])
  } finally {
    seam.pending?.()
    await (stopping ?? watcher.stop())
    seam.pending = null
    seam.hold = false
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  }
})
