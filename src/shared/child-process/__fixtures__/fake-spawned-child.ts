import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { vi } from 'vitest'

/**
 * A `child_process.spawn` stand-in for suites that drive gh/glab/git runners.
 *
 * Those runners capture output through `runProcess`, which reads the streams
 * and waits for `close`, so a bare EventEmitter is not enough — a test child
 * has to carry stdio and report an exit or the promise never settles.
 */
export function createFakeSpawnedChild(pid = 4321): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = pid
  child.kill = vi.fn(() => true)
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

/** Emit output and a clean exit, the way a CLI that answered would. */
export function completeFakeSpawn(
  child: ChildProcess,
  result: { stdout?: string; stderr?: string; code?: number } = {}
): void {
  if (result.stdout) {
    child.stdout?.emit('data', Buffer.from(result.stdout))
  }
  if (result.stderr) {
    child.stderr?.emit('data', Buffer.from(result.stderr))
  }
  const code = result.code ?? 0
  child.emit('exit', code, null)
  child.emit('close', code, null)
}

/** What a faked spawn should do: answer, or fail to start at all. */
export type FakeSpawnOutcome =
  | { stdout?: string; stderr?: string; code?: number }
  | { spawnError: Error }

function settleFakeSpawn(child: ChildProcess, outcome: FakeSpawnOutcome): void {
  if ('spawnError' in outcome) {
    // Why an event and not a throw: an unresolvable program fails asynchronously
    // in libuv, which is what makes ENOENT reach callers as a rejection.
    child.emit('error', outcome.spawnError)
    return
  }
  completeFakeSpawn(child, outcome)
}

/**
 * Build a `spawn` implementation that answers every call the same way.
 *
 * Why a fresh child per call: the runners retry and fall back, and a shared
 * emitter would replay the first call's exit into the second's listeners.
 */
export function fakeSpawnReturning(
  outcome: FakeSpawnOutcome = {}
): (program: string, args: readonly string[]) => ChildProcess {
  return fakeSpawnDispatch(() => outcome)
}

/** Build a `spawn` implementation that answers per invoked program and argv. */
export function fakeSpawnDispatch(
  resolve: (program: string, args: readonly string[]) => FakeSpawnOutcome
): (program: string, args: readonly string[]) => ChildProcess {
  return (program, args) => {
    const child = createFakeSpawnedChild()
    const outcome = resolve(program, args)
    queueMicrotask(() => settleFakeSpawn(child, outcome))
    return child
  }
}
