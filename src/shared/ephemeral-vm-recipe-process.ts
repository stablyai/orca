import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'
import { admitProcessTreeKill } from '@orca/process-host/process-tree-kill-gate'
import { GrowingByteBuffer } from '@orca/process-host/growing-byte-buffer'

export const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024
const CANCEL_FORCE_KILL_DELAY_MS = 5_000

export type ProcessRunResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  aborted?: true
}

export function quoteShellToken(value: string): string {
  if (process.platform === 'win32') {
    // Inside cmd.exe double quotes, `^` is literal; an embedded `"` is escaped
    // by doubling it. This token is only displayed for manual cleanup, so it
    // must be valid when pasted into cmd.exe.
    return `"${value.replace(/"/g, '""')}"`
  }
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function runRecipeCommand(args: {
  command: string
  repoPath: string
  context: EphemeralVmRecipeContext
  mode: 'create' | 'suspend' | 'resume' | 'destroy'
  resultSchemaVersion: 1 | 2
  stdin?: string
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  spawnCommand?: typeof spawn
}): Promise<ProcessRunResult> {
  const maxBytes = clampRecipeCaptureBytes(args.maxCaptureBytes)
  const spawnCommand = args.spawnCommand ?? spawn

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnCommand(args.command, {
        cwd: args.repoPath,
        detached: process.platform !== 'win32',
        env: buildRecipeEnv(args.env, args.mode, args.context, args.resultSchemaVersion),
        shell: true,
        windowsHide: true
      }) as ChildProcessWithoutNullStreams
    } catch (error) {
      reject(error)
      return
    }

    const stdout = new GrowingByteBuffer()
    const stderr = new GrowingByteBuffer()
    let settled = false
    let aborted = false
    let forceKillTimer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: Omit<ProcessRunResult, 'stdout' | 'stderr'>): void => {
      if (settled) {
        return
      }
      settled = true
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      args.signal?.removeEventListener('abort', abort)
      resolve({ stdout: takeRetainedTail(stdout), stderr: takeRetainedTail(stderr), ...result })
    }
    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      args.signal?.removeEventListener('abort', abort)
      stdout.clear()
      stderr.clear()
      reject(error)
    }
    const abort = (): void => {
      if (settled) {
        return
      }
      aborted = true
      forceKillTimer = setTimeout(() => {
        if (settled) {
          return
        }
        killRecipeProcess(child, true)
        finish({ exitCode: null, signal: null, aborted: true })
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
      }, CANCEL_FORCE_KILL_DELAY_MS)
      forceKillTimer.unref()
      killRecipeProcess(child)
    }

    // No setEncoding: the retained tail stays raw bytes, and a per-stream StringDecoder gives the
    // callbacks the same character boundaries setEncoding would have (it uses the same decoder).
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const capture = (
      buffer: GrowingByteBuffer,
      decoder: StringDecoder,
      chunk: Buffer,
      forward: ((chunk: string) => void) | undefined
    ): void => {
      if (!settled) {
        buffer.appendRetainedSuffix(chunk, maxBytes)
      }
      if (!forward) {
        return
      }
      const decoded = decoder.write(chunk)
      if (decoded.length > 0) {
        forward(decoded)
      }
    }
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, stdoutDecoder, chunk, args.onStdout))
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, stderrDecoder, chunk, args.onStderr))
    // setEncoding flushes its decoder at end-of-stream; keep that final replacement character.
    child.stdout.on('end', () => flushDecoder(stdoutDecoder, args.onStdout))
    child.stderr.on('end', () => flushDecoder(stderrDecoder, args.onStderr))
    child.on('error', (error) => {
      fail(error)
    })
    child.on('close', (exitCode, signal) => {
      finish({ exitCode, signal, ...(aborted ? { aborted: true } : {}) })
    })

    if (args.signal?.aborted) {
      abort()
    } else {
      args.signal?.addEventListener('abort', abort, { once: true })
    }

    if (args.stdin) {
      child.stdin.end(args.stdin)
    } else {
      child.stdin.end()
    }
  })
}

/** No production caller overrides the cap, so odd values are clamped rather than coerced per chunk. */
export function clampRecipeCaptureBytes(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) {
    return DEFAULT_MAX_CAPTURE_BYTES
  }
  if (value <= 0) {
    return 0
  }
  const floored = Math.floor(value)
  return Number.isSafeInteger(floored) ? floored : DEFAULT_MAX_CAPTURE_BYTES
}

// Retention cuts on a byte boundary, so drop the partial sequence the old per-chunk trim removed.
function takeRetainedTail(buffer: GrowingByteBuffer): string {
  const bytes = buffer.takeBuffer()
  let start = 0
  while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) {
    start += 1
  }
  return bytes.toString('utf8', start)
}

function flushDecoder(
  decoder: StringDecoder,
  forward: ((chunk: string) => void) | undefined
): void {
  const trailing = decoder.end()
  if (trailing.length > 0) {
    forward?.(trailing)
  }
}

/** Exported for the refusal-fallback test; the abort path is otherwise unreachable. */
export function killRecipeProcess(child: ChildProcessWithoutNullStreams, force = false): void {
  const signal = force ? 'SIGKILL' : 'SIGTERM'
  if (process.platform === 'win32') {
    // Recipes run through `cmd.exe /c` (shell: true), so child.kill() would only
    // terminate the wrapper and orphan the actual recipe subprocess (e.g. a cloud
    // CLI mid-provision). taskkill /T walks and kills the whole tree.
    if (child.pid) {
      if (
        !admitProcessTreeKill({
          pid: child.pid,
          site: 'ephemeral-vm-recipe',
          scope: 'win-taskkill-tree'
        })
      ) {
        // Refusal blocks the tree walk, not the termination: the root kill is
        // handle-addressed, so it cannot reach the recycled pid we refused.
        child.kill(signal)
        return
      }
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => child.kill(signal))
      return
    }
    child.kill(signal)
    return
  }
  if (child.pid) {
    try {
      // Recipes run through a shell; kill the process group so shell children do not linger.
      process.kill(-child.pid, signal)
      return
    } catch {
      // Fall back to killing the direct child if the process group is already gone.
    }
  }
  child.kill(signal)
}

function buildRecipeEnv(
  env: NodeJS.ProcessEnv | undefined,
  mode: 'create' | 'suspend' | 'resume' | 'destroy',
  context: EphemeralVmRecipeContext,
  resultSchemaVersion: 1 | 2
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...env,
    ORCA_VM_MODE: mode,
    ORCA_VM_INSTANCE_ID: context.instanceId ?? '',
    ORCA_RECIPE_ID: context.recipeId,
    ORCA_PROJECT_ID: context.projectId ?? '',
    ORCA_WORKSPACE_ID: context.workspaceId ?? '',
    ORCA_WORKSPACE_NAME: context.workspaceName ?? '',
    ORCA_REPO_PATH: context.repoPath,
    ORCA_REPO_URL: context.repoUrl ?? '',
    ORCA_REPO_BRANCH: context.branch ?? '',
    ORCA_REPO_REF: context.ref ?? '',
    ORCA_REPO_REF_HEAD: context.expectedRefHead ?? '',
    ORCA_RECIPE_RESULT_SCHEMA_VERSION: String(resultSchemaVersion),
    ORCA_VERSION: context.orcaVersion ?? ''
  }
}
