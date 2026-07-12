import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import type { EphemeralVmRecipeContext } from './ephemeral-vm-recipe-runner'

const DEFAULT_MAX_CAPTURE_BYTES = 1024 * 1024

export type ProcessRunResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: NodeJS.Signals | null
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
  stdin?: string
  env?: NodeJS.ProcessEnv
  maxCaptureBytes?: number
  signal?: AbortSignal
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  spawnCommand?: typeof spawn
}): Promise<ProcessRunResult> {
  const maxBytes = args.maxCaptureBytes ?? DEFAULT_MAX_CAPTURE_BYTES
  const spawnCommand = args.spawnCommand ?? spawn

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnCommand(args.command, {
        cwd: args.repoPath,
        detached: process.platform !== 'win32',
        env: buildRecipeEnv(args.env, args.mode, args.context),
        shell: true,
        windowsHide: true
      }) as ChildProcessWithoutNullStreams
    } catch (error) {
      reject(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const abort = (): void => {
      if (settled) {
        return
      }
      killRecipeProcess(child)
    }

    args.signal?.addEventListener('abort', abort, { once: true })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout = appendBounded(stdout, chunk, maxBytes)
      args.onStdout?.(chunk)
    })
    child.stderr.on('data', (chunk: string) => {
      stderr = appendBounded(stderr, chunk, maxBytes)
      args.onStderr?.(chunk)
    })
    child.on('error', (error) => {
      settled = true
      args.signal?.removeEventListener('abort', abort)
      reject(error)
    })
    child.on('close', (exitCode, signal) => {
      settled = true
      args.signal?.removeEventListener('abort', abort)
      resolve({ stdout, stderr, exitCode, signal })
    })

    if (args.stdin) {
      child.stdin.end(args.stdin)
    } else {
      child.stdin.end()
    }
  })
}

function killRecipeProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === 'win32') {
    // Recipes run through `cmd.exe /c` (shell: true), so child.kill() would only
    // terminate the wrapper and orphan the actual recipe subprocess (e.g. a cloud
    // CLI mid-provision). taskkill /T walks and kills the whole tree.
    if (child.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      killer.on('error', () => child.kill())
      return
    }
    child.kill()
    return
  }
  if (child.pid) {
    try {
      // Recipes run through a shell; kill the process group so shell children do not linger.
      process.kill(-child.pid, 'SIGTERM')
      return
    } catch {
      // Fall back to killing the direct child if the process group is already gone.
    }
  }
  child.kill()
}

function buildRecipeEnv(
  env: NodeJS.ProcessEnv | undefined,
  mode: 'create' | 'suspend' | 'resume' | 'destroy',
  context: EphemeralVmRecipeContext
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
    ORCA_VERSION: context.orcaVersion ?? ''
  }
}

function appendBounded(current: string, chunk: string, maxBytes: number): string {
  const next = current + chunk
  if (Buffer.byteLength(next, 'utf8') <= maxBytes) {
    return next
  }
  return next.slice(-maxBytes)
}
