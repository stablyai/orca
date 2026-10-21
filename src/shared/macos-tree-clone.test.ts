import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>()
}))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { cloneMacTree } from './macos-tree-clone'

const ok: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }

describe('cloneMacTree', () => {
  let root: string
  let destination: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-mac-tree-clone-'))
    destination = join(root, 'copy')
    runProcessMock.mockReset()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const flags = (): (string | undefined)[] =>
    runProcessMock.mock.calls.map(([spec]) => spec.args?.[0])

  it('clones once when the APFS clone succeeds', async () => {
    runProcessMock.mockResolvedValue(ok)
    const signal = new AbortController().signal
    await expect(cloneMacTree('/src', destination, { signal })).resolves.toBe(true)
    expect(runProcessMock).toHaveBeenCalledTimes(1)
    expect(runProcessMock.mock.calls[0][0]).toMatchObject({
      program: '/bin/cp',
      args: ['-cR', '/src', destination],
      signal
    })
  })

  it('falls back to a plain copy over a cleared destination when the clone fails', async () => {
    const seenAtCopy: boolean[] = []
    runProcessMock.mockImplementation(async (spec) => {
      seenAtCopy.push(existsSync(destination))
      if (spec.args?.[0] === '-cR') {
        await mkdir(destination)
        await writeFile(join(destination, 'partial'), 'partial-clone')
        return { ...ok, code: 1 }
      }
      return ok
    })
    await writeFile(destination, 'stale')
    await expect(cloneMacTree('/src', destination)).resolves.toBe(true)
    expect(flags()).toEqual(['-cR', '-R'])
    expect(seenAtCopy).toEqual([false, false])
  })

  it('treats a timed-out copy as failed', async () => {
    runProcessMock.mockResolvedValueOnce({ ...ok, timedOut: true }).mockResolvedValueOnce(ok)
    await expect(cloneMacTree('/src', destination)).resolves.toBe(true)
    expect(flags()).toEqual(['-cR', '-R'])
  })

  it('resolves false when both copies fail', async () => {
    runProcessMock.mockResolvedValue({ ...ok, code: 1 })
    await expect(cloneMacTree('/src', destination)).resolves.toBe(false)
    expect(flags()).toEqual(['-cR', '-R'])
  })

  it('clears the destination with the caller-supplied rm', async () => {
    runProcessMock.mockResolvedValue({ ...ok, code: 1 })
    const removed: string[] = []
    const callerRm = vi.fn(async (path: Parameters<typeof rm>[0]) => {
      removed.push(String(path))
    })
    await cloneMacTree('/src', destination, { rm: callerRm })
    expect(removed).toEqual([destination, destination])
  })
})
