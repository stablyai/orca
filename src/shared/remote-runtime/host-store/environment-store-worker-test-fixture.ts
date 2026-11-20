// @orca-isolated-worker: a real worker and its closed owner belong to this test file.
import type * as WorkerSpawn from '../../../main/worker-threads/worker-thread-spawn'
import type * as WorkerEntry from '../../../main/worker-threads/worker-thread-entry-path'
import type { Worker } from 'node:worker_threads'
import { buildSync } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, vi } from 'vitest'
import { closeEnvironmentStore } from './runtime-environment-store-worker-client'

const startedWorkers = new Set<Worker>()
vi.mock('../../../main/worker-threads/worker-thread-spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerSpawn>()
  return {
    ...actual,
    spawnWorkerThread: (...args: Parameters<typeof actual.spawnWorkerThread>) => {
      const worker = actual.spawnWorkerThread(...args)
      startedWorkers.add(worker)
      worker.once('exit', () => startedWorkers.delete(worker))
      return worker
    }
  }
})

let bundleRoot: string | undefined
function workerPath(): string {
  if (!bundleRoot) {
    bundleRoot = mkdtempSync(join(tmpdir(), 'orca-environment-worker-'))
    buildSync({
      entryPoints: [
        resolve('src/shared/remote-runtime/host-store/runtime-environment-store-worker-entry.ts')
      ],
      outfile: join(bundleRoot, 'runtime-environment-store-worker-entry.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
  }
  return join(bundleRoot, 'runtime-environment-store-worker-entry.js')
}
vi.mock('../../../main/worker-threads/worker-thread-entry-path', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerEntry>()
  return {
    ...actual,
    resolveWorkerThreadEntryPath: (
      ...args: Parameters<typeof actual.resolveWorkerThreadEntryPath>
    ) =>
      args[1] === 'runtime-environment-store-worker-entry.js'
        ? workerPath()
        : actual.resolveWorkerThreadEntryPath(...args)
  }
})
afterAll(async () => {
  await closeEnvironmentStore()
  await Promise.all([...startedWorkers].map((worker) => worker.terminate()))
  if (bundleRoot) {
    rmSync(bundleRoot, { recursive: true, force: true })
  }
})
