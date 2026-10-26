import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { vi } from 'vitest'

/** runProcess waits for stdio and close; a bare EventEmitter leaves mocked gh/glab/git runners pending. */
export function createFakeSpawnedChild(pid = 4321): ChildProcess {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>
  child.pid = pid
  child.kill = vi.fn(() => true)
  child.stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child as unknown as ChildProcess
}

export function createFakePipedChild(pid = 4321) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  return Object.assign(createFakeSpawnedChild(pid), {
    pid,
    stdin,
    stdout,
    stderr,
    stdio: [stdin, stdout, stderr, null, null] satisfies PipedChildProcess['stdio'],
    kill: vi.fn((_signal?: NodeJS.Signals | number) => true)
  })
}

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
    // libuv reports missing executables asynchronously through error, not a spawn throw.
    child.emit('error', outcome.spawnError)
    return
  }
  completeFakeSpawn(child, outcome)
}

/** Use a fresh child per retry/fallback so earlier exits cannot reach later listeners. */
export function fakeSpawnReturning(
  outcome: FakeSpawnOutcome = {}
): (program: string, args: readonly string[]) => ChildProcess {
  return fakeSpawnDispatch(() => outcome)
}

export function fakeSpawnDispatch(
  resolve: (program: string, args: readonly string[]) => FakeSpawnOutcome
): (program: string, args: readonly string[]) => ChildProcess {
  return (program, args) => {
    const child = createFakeSpawnedChild()
    const outcome = resolve(program, args)
    if ('spawnError' in outcome) {
      Object.defineProperty(child, 'pid', { value: undefined })
    }
    queueMicrotask(() => settleFakeSpawn(child, outcome))
    return child
  }
}
