import type * as ChildProcessModule from 'node:child_process'
import { PassThrough } from 'node:stream'
import type { PipedChildProcess } from '@orca/process-host/process-spec'
import { vi } from 'vitest'

// Consumers may mock spawn without exporting the ChildProcess constructor.
const { ChildProcess: NodeChildProcess } = process.getBuiltinModule('node:child_process')

class FakeSpawnedChild extends NodeChildProcess {
  override pid: number
  override stdin = new PassThrough()
  override stdout = new PassThrough()
  override stderr = new PassThrough()
  override stdio: PipedChildProcess['stdio'] = [this.stdin, this.stdout, this.stderr, null, null]
  override kill = vi.fn((_signal?: NodeJS.Signals | number) => true)
  override unref = vi.fn<() => void>()

  constructor(pid: number) {
    super()
    this.pid = pid
  }
}

/** Stream cleanup must not imply child exit; tests explicitly emit exit/close. */
export function createFakeSpawnedChild(pid = 4321) {
  return new FakeSpawnedChild(pid)
}

export function createFakePipedChild(pid = 4321) {
  return createFakeSpawnedChild(pid)
}

export function completeFakeSpawn(
  child: ChildProcessModule.ChildProcess,
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

function settleFakeSpawn(child: ChildProcessModule.ChildProcess, outcome: FakeSpawnOutcome): void {
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
): (program: string, args: readonly string[]) => ChildProcessModule.ChildProcess {
  return fakeSpawnDispatch(() => outcome)
}

export function fakeSpawnDispatch(
  resolve: (program: string, args: readonly string[]) => FakeSpawnOutcome
): (program: string, args: readonly string[]) => ChildProcessModule.ChildProcess {
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
