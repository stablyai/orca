import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { describe, expect, it, vi } from 'vitest'
import { runProcess, type ProcessSpec } from './run-process'

const CONTENT_BYTES = 2 * 1024 * 1024
const CHILD_SCRIPT = `
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(Buffer.alloc(${CONTENT_BYTES}, 65), () => {
  const child = require('node:child_process').spawn(
    process.execPath, ['-e', 'setTimeout(() => {}, 20000)'],
    { stdio: ['ignore', 1, 2], windowsHide: true }
  );
  require('node:fs').writeFileSync(process.argv[1], String(child.pid));
  child.unref();
  process.exit(0);
}));
`

async function collect(): Promise<void> {
  if (!('gc' in globalThis) || typeof globalThis.gc !== 'function') {
    throw new Error('The test runner must enable --expose-gc')
  }
  for (let round = 0; round < 8; round += 1) {
    await nextTurn()
    globalThis.gc()
  }
}

function start(pidFile: string, signal: AbortSignal, onChildTerminated: () => void) {
  const spec: ProcessSpec = {
    program: process.execPath,
    args: ['-e', CHILD_SCRIPT, pidFile],
    input: Buffer.alloc(CONTENT_BYTES, 66).toString('utf8'),
    timeoutMs: 10_000,
    signal,
    onChildTerminated
  }
  return { reference: new WeakRef(spec), pending: runProcess(spec) }
}

async function runAndForget(
  pidFile: string,
  signal: AbortSignal,
  onChildTerminated: () => void
): Promise<WeakRef<ProcessSpec>> {
  const { reference, pending } = start(pidFile, signal, onChildTerminated)
  const result = await pending
  expect(result.timedOut).toBe(false)
  expect(result.stdout).toBe('A'.repeat(CONTENT_BYTES))
  return reference
}

async function readOwnedPid(pidFile: string): Promise<number | null> {
  try {
    const pid = Number(await readFile(pidFile, 'utf8'))
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

describe('runProcess inherited pipe retention', () => {
  it('releases capture payloads after fallback while retaining late termination proof', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-inherited-pipes-'))
    const pidFiles = Array.from({ length: 4 }, (_, index) => join(directory, String(index)))
    const controller = new AbortController()
    const onChildTerminated = vi.fn()
    let operations: Promise<WeakRef<ProcessSpec>>[] = []
    try {
      await collect()
      const baseline = process.memoryUsage().arrayBuffers
      operations = pidFiles.map((pidFile) =>
        runAndForget(pidFile, controller.signal, onChildTerminated)
      )
      await expect
        .poll(async () => (await Promise.all(pidFiles.map(readOwnedPid))).every(Boolean), {
          timeout: 5_000
        })
        .toBe(true)
      controller.abort()
      const references = await Promise.all(operations)
      await collect()
      expect(onChildTerminated).not.toHaveBeenCalled()
      expect(references.every((reference) => reference.deref() === undefined)).toBe(true)
      expect(process.memoryUsage().arrayBuffers - baseline).toBeLessThan(1024 * 1024)
    } finally {
      controller.abort()
      await Promise.allSettled(operations)
      for (const pidFile of pidFiles) {
        const pid = await readOwnedPid(pidFile)
        if (pid !== null) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            // The finite-lifetime fixture may already have exited.
          }
        }
      }
      await rm(directory, { recursive: true, force: true })
    }
    await expect.poll(() => onChildTerminated.mock.calls.length).toBe(4)
  })
})
