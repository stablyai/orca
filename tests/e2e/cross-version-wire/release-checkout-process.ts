export const CHECKOUT_PROCESS_TIMEOUT_MS = 45_000
const CHECKOUT_MAX_OUTPUT_BYTES = 1024 * 1024

export async function runCheckoutProcess(
  repoRoot: string,
  program: string,
  args: string[],
  deadline: number,
  options: { input?: string; maxOutputBytes?: number } = {}
): Promise<string> {
  // Kept lazy so plain Node 24 contention children never load Vite's TS graph.
  const { runProcess } = await import('@orca/process-host')
  const result = await runProcess({
    program,
    args,
    cwd: repoRoot,
    timeoutMs: Math.max(1, deadline - Date.now()),
    maxOutputBytes: options.maxOutputBytes ?? CHECKOUT_MAX_OUTPUT_BYTES,
    input: options.input,
    terminationBarrier: true
  })
  if (result.code === 0 && !result.timedOut) {
    return result.stdout
  }
  const detail = result.timedOut
    ? `timed out after ${CHECKOUT_PROCESS_TIMEOUT_MS}ms`
    : result.stderr.trim() || `exited with ${result.code}`
  throw new Error(`${program} ${args[0] ?? ''} ${detail}`)
}
