// `fork` arm of Orca's child-process chokepoint. Kept beside `run-process.ts` for the same
// reason that file exists: callers outside this directory must not import `node:child_process`,
// and a guard test enforces that against a shrinking allowlist.
import {
  fork as nodeFork,
  type ForkOptions,
  type SpawnOptions as NodeSpawnOptions
} from 'node:child_process'
import type { SpawnedProcess } from './process-spec'

/**
 * What `spawnProcess` cannot express: a Node child with an IPC channel, started from a module
 * path rather than a program, optionally under a different Node/Electron binary than this
 * process's own.
 *
 * `fork` is the right primitive for that and there is no spawn-based substitute — the existing
 * launch paths and their tests are written against `fork`'s contract (module path resolution,
 * `execPath` override, inherited `execArgv`), and a spawn rewrite would change all three.
 */
export type ForkSpec = {
  /** Node module to run as the child's entry point. */
  modulePath: string
  args?: readonly string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Keep the child in its own POSIX process group so it outlives this process. */
  detached?: boolean
  /** Must keep an `'ipc'` slot; without one the child gets no channel and cannot `send`. */
  stdio?: NodeSpawnOptions['stdio']
  /** Run a different Node/Electron binary — e.g. a relocated executable image. */
  execPath?: string
}

export function forkProcess(spec: ForkSpec): SpawnedProcess {
  return nodeFork(spec.modulePath, [...(spec.args ?? [])], {
    cwd: spec.cwd,
    env: spec.env,
    detached: spec.detached,
    stdio: spec.stdio,
    // Why conditional rather than `execPath: spec.execPath`: an explicit `undefined` is not the
    // same as absent to Node, which reads the key to decide whether to override its own binary.
    ...(spec.execPath ? { execPath: spec.execPath } : {}),
    // Why the assertion: `ForkOptions` does not declare `windowsHide`, but Node forwards the
    // option to `spawn` at runtime, so the flag every other call site in this directory sets is
    // reachable here too. Inert for a GUI-subsystem binary and for `detached`, which already
    // gets no inherited console — but a console-subsystem `execPath` would otherwise flash one.
    windowsHide: true
  } as ForkOptions)
}
