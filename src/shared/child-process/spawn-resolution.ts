import type { SpawnOptions as NodeSpawnOptions } from 'node:child_process'
import { buildWindowsCmdShimCommandLine, isCmdInterpretedProgram } from './windows-command-line'
import { resolveWindowsCmdShim } from './windows-cmd-shim-resolution'
import type { ProcessSpec } from './process-spec'

export type ResolvedSpawn = {
  file: string
  args: readonly string[]
  options: NodeSpawnOptions
}

/**
 * Translate a spec into the exact `child_process.spawn` call to make.
 *
 * Exported so the Windows branch is testable from macOS/Linux: the decisions
 * below are the whole point of the spawn chokepoint, and they must not be
 * observable only on the platform that breaks.
 *
 * Pure except on the win32 `.cmd` branch, where shim resolution does a `stat`
 * and (on a cache miss) one bounded read of the shim itself. Both are inside
 * try/catch and any failure falls back to the cmd.exe path, so the function
 * still cannot throw or reach anything but the program path it was handed.
 */
export function resolveSpawn(spec: ProcessSpec, platform: NodeJS.Platform): ResolvedSpawn {
  const args = spec.args ?? []
  const base: NodeSpawnOptions = {
    cwd: spec.cwd,
    env: spec.env,
    stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'],
    // Why unconditional: Orca's main process is GUI-subsystem and owns no
    // console, so every console-subsystem child it starts gets a fresh visible
    // conhost that takes foreground — keystrokes typed into an Orca terminal at
    // that moment land in the black box instead.
    windowsHide: true,
    detached: spec.detached,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
    // Why never `shell: true`: it concatenates arguments without escaping (Node
    // itself warns DEP0190) and it silently makes windowsHide a no-op.
    shell: false,
    ...(spec.terminationBarrier && platform !== 'win32' ? { detached: true } : {})
  }

  if (platform !== 'win32' || !isCmdInterpretedProgram(spec.program)) {
    return { file: spec.program, args, options: base }
  }

  // An npm/pnpm shim is a generated file that only locates node and runs a
  // script, so reading it lets us spawn that program directly. That drops
  // cmd.exe from the tree — which is what Defender scores as obfuscation once
  // the caret-escaped payload is agent prompt text — and lifts cmd's ban on
  // arguments containing a line break. Unrecognised shims resolve to null and
  // keep the cmd.exe path below.
  const shim = resolveWindowsCmdShim(spec.program, spec.env ?? process.env)
  if (shim) {
    return {
      file: shim.program,
      args: [...shim.prefixArgs, ...args],
      options: {
        ...base,
        ...(shim.env ? { env: shim.env } : {}),
        // Why cleared rather than inherited: the flag exists for callers that
        // hand us a whole pre-built command line, and there is no such line
        // here — Node would join `[script, ...args]` unquoted and shred any
        // argument containing a space.
        windowsVerbatimArguments: undefined
      }
    }
  }

  // Node refuses to spawn `.cmd`/`.bat` without a shell (EINVAL, the
  // CVE-2024-27980 mitigation), so cmd.exe has to be the program. Building the
  // line ourselves — rather than handing Node `shell: true` — is what keeps the
  // arguments intact and the console hidden.
  const comSpec = spec.env?.ComSpec ?? process.env.ComSpec ?? 'cmd.exe'
  return {
    file: comSpec,
    args: [buildWindowsCmdShimCommandLine(spec.program, args)],
    options: { ...base, windowsVerbatimArguments: true }
  }
}
