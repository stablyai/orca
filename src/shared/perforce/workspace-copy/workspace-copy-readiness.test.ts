import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeCopyHost } from './__fixtures__/fake-copy-host'
import { FakePerforceServer } from './__fixtures__/fake-perforce-server'
import { probeBlockCloning, resetBlockCloningProbeCacheForTests } from './workspace-copy-readiness'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'p4probe-'))
  resetBlockCloningProbeCacheForTests()
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(async () => {
  vi.useRealTimers()
  await rm(dir, { recursive: true, force: true })
})

describe('probeBlockCloning', () => {
  it('remembers for a few minutes that a volume does not block-clone', async () => {
    const host = createFakeCopyHost(new FakePerforceServer(), dir, { blockClones: false })
    await expect(probeBlockCloning(host, dir)).resolves.toBe('not-cloning')
    expect(host.robocopyCalls).toHaveLength(2)
    vi.advanceTimersByTime(4 * 60_000)
    await expect(probeBlockCloning(host, dir)).resolves.toBe('not-cloning')
    expect(host.robocopyCalls).toHaveLength(2)
  })
})
