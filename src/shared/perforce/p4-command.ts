import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { runProcess } from '../child-process/run-process'

const P4_TIMEOUT_MS = 60_000
const P4_MAX_OUTPUT_BYTES = 64 * 1024 * 1024

export type P4CommandResult = { code: number | null; stdout: string; stderr: string }

export class P4NotFoundError extends Error {
  constructor() {
    super('The Perforce command-line client (p4) was not found. Install it or set ORCA_P4_PATH.')
    this.name = 'P4NotFoundError'
  }
}

let resolvedP4: string | null = null

const EXTRA_P4_DIRS =
  process.platform === 'win32'
    ? ['C:\\Program Files\\Perforce']
    : ['/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin']

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function resolveP4Binary(): Promise<string> {
  if (resolvedP4) {
    return resolvedP4
  }
  const override = process.env.ORCA_P4_PATH?.trim()
  if (override && (await isExecutable(override))) {
    resolvedP4 = override
    return override
  }
  const fileName = process.platform === 'win32' ? 'p4.exe' : 'p4'
  // Why: GUI-launched apps often inherit a minimal PATH, so also probe common install dirs.
  const dirs = [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_P4_DIRS].filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, fileName)
    if (await isExecutable(candidate)) {
      resolvedP4 = candidate
      return candidate
    }
  }
  throw new P4NotFoundError()
}

export function resetP4BinaryCacheForTests(): void {
  resolvedP4 = null
}

export type P4RunOptions = {
  cwd: string
  /** Text piped to stdin (e.g. a changelist spec for `change -i`). */
  input?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/** Runs `p4 <args>` in `cwd`; a non-zero exit is returned, not thrown. */
export async function runP4(
  args: readonly string[],
  options: P4RunOptions
): Promise<P4CommandResult> {
  const program = await resolveP4Binary()
  const result = await runProcess({
    program,
    args,
    cwd: options.cwd,
    input: options.input,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? P4_TIMEOUT_MS,
    maxOutputBytes: P4_MAX_OUTPUT_BYTES
  })
  if (result.timedOut) {
    throw new Error(`p4 ${args[0] ?? ''} timed out`)
  }
  return { code: result.code, stdout: result.stdout, stderr: result.stderr }
}

/** Runs p4 and throws with p4's own message on failure. */
export async function runP4OrThrow(
  args: readonly string[],
  options: P4RunOptions
): Promise<string> {
  const result = await runP4(args, options)
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `p4 ${args[0]} failed`)
  }
  return result.stdout
}

/** Escapes characters p4 treats as wildcards or revision markers in file arguments. */
export function escapeP4FileArg(path: string): string {
  return path
    .replaceAll('%', '%25')
    .replaceAll('@', '%40')
    .replaceAll('#', '%23')
    .replaceAll('*', '%2A')
}
