export const CHECKOUT_PROCESS_TIMEOUT_MS = 45_000
const CHECKOUT_MAX_OUTPUT_BYTES = 1024 * 1024

// Timed consumers must not turn a local read into another network request.
export const LOCAL_RELEASE_GIT_ENV = { GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }

export async function runCheckoutProcess(
  repoRoot: string,
  program: string,
  args: string[],
  deadline: number,
  options: { input?: string; maxOutputBytes?: number; timeoutMs?: number } = {}
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? CHECKOUT_PROCESS_TIMEOUT_MS
  const operation = args.includes('fetch') ? 'fetch' : (args[0] ?? '')
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    throw new Error(`${program} ${operation} timed out after ${timeoutMs}ms`)
  }
  // Kept lazy so plain Node 24 contention children never load Vite's TS graph.
  const { runProcess } = await import('@orca/process-host')
  const result = await runProcess({
    program,
    args,
    cwd: repoRoot,
    env: { ...process.env, ...LOCAL_RELEASE_GIT_ENV },
    timeoutMs: Math.max(1, deadline - Date.now()),
    maxOutputBytes: options.maxOutputBytes ?? CHECKOUT_MAX_OUTPUT_BYTES,
    killOnOutputLimit: true,
    input: options.input,
    terminationBarrier: true
  })
  if (result.code === 0 && !result.timedOut && !result.outputTruncated) {
    return result.stdout
  }
  const detail = result.timedOut
    ? `timed out after ${timeoutMs}ms`
    : result.outputTruncated
      ? 'exceeded output limit'
      : result.stderr.trim() || `exited with ${result.code}`
  throw new Error(`${program} ${operation} ${detail}`)
}
