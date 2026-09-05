import { spawn, type ChildProcess } from 'node:child_process'

export type MuseHeadlessExecOptions = {
  binary?: string
  prompt: string
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  extraArgs?: string[]
  spawnFn?: typeof spawn
}

export type MuseHeadlessExecResult = {
  exitCode: number
  stdout: string
  stderr: string
}

const REDACTED_SECRET = '[SANITIZADO]'

/**
 * Sanitizes any potential credential patterns from error messages or logs
 * so no API key or token is leaked into traces or console output.
 */
export function sanitizeLogOutput(text: string): string {
  return text
    .replace(/(?:meta_api_key|api[_-]?key|bearer\s+|token=)["']?[\w-]{16,}["']?/gi, REDACTED_SECRET)
    .replace(/EAAB[\w]+/g, REDACTED_SECRET)
}

/**
 * Builds structured argv array for headless execution.
 * Preserves the exact prompt without shell string interpolation hazards.
 */
export function buildMuseExecArgs(prompt: string, extraArgs?: string[]): string[] {
  const args = ['exec']
  if (extraArgs && extraArgs.length > 0) {
    args.push(...extraArgs)
  }
  args.push(prompt)
  return args
}

/**
 * Identifies if an agent command line or argument list represents a headless one-shot invocation.
 */
export function isMuseHeadlessCommand(argsOrCommand: string | readonly string[]): boolean {
  if (Array.isArray(argsOrCommand)) {
    return argsOrCommand[0] === 'exec' || (argsOrCommand[0] === 'muse' && argsOrCommand[1] === 'exec')
  }
  const trimmed = argsOrCommand.trim()
  return trimmed.startsWith('muse exec') || trimmed === 'exec'
}

/**
 * Executes a one-shot headless prompt via `muse exec "<prompt>"`.
 * Preserves cwd, stdout, stderr, exit code, timeout, and cancellation.
 */
export async function executeMuseHeadless(
  options: MuseHeadlessExecOptions
): Promise<MuseHeadlessExecResult> {
  const {
    binary = 'muse',
    prompt,
    cwd,
    timeoutMs,
    signal,
    env,
    extraArgs,
    spawnFn = spawn
  } = options

  const argv = buildMuseExecArgs(prompt, extraArgs)

  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null
    let child: ChildProcess | null = null

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
    }

    const onAbort = () => {
      cleanup()
      if (child && !child.killed) {
        child.kill('SIGTERM')
      }
      reject(new Error('Muse headless execution was cancelled'))
    }

    if (signal?.aborted) {
      return reject(new Error('Muse headless execution was cancelled'))
    }

    try {
      child = spawnFn(binary, argv, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return reject(
          new Error(
            `Meta Muse CLI ('${binary}') is not installed or not found on PATH. ` +
              `Please ensure the binary is installed and available.`
          )
        )
      }
      return reject(new Error(sanitizeLogOutput(err?.message || String(err))))
    }

    if (signal) {
      signal.addEventListener('abort', onAbort)
    }

    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        if (child && !child.killed) {
          child.kill('SIGTERM')
        }
        cleanup()
        reject(new Error(`Muse headless execution timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    }

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (data: Buffer | string) => {
      stdout += data.toString()
    })

    child.stderr?.on('data', (data: Buffer | string) => {
      stderr += data.toString()
    })

    child.on('error', (err: any) => {
      cleanup()
      if (err?.code === 'ENOENT') {
        return reject(
          new Error(
            `Meta Muse CLI ('${binary}') is not installed or not found on PATH. ` +
              `Please ensure the binary is installed and available.`
          )
        )
      }
      reject(new Error(sanitizeLogOutput(err?.message || String(err))))
    })

    child.on('close', (code, _signal) => {
      cleanup()
      const exitCode = typeof code === 'number' ? code : 1
      resolve({
        exitCode,
        stdout,
        stderr: sanitizeLogOutput(stderr)
      })
    })
  })
}
