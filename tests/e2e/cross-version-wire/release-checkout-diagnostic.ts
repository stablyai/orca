import { mkdtemp, open, rm } from 'node:fs/promises'
import { availableParallelism, freemem, loadavg, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'

export const checkoutDiagnosticEnabled = () => process.env.ORCA_RELEASE_CHECKOUT_DIAGNOSTIC === '1'

export function checkoutDiagnostic(phase: string, commit: string, deadline?: number): void {
  if (!checkoutDiagnosticEnabled()) {
    return
  }
  console.error(
    '[release-checkout-phase]',
    JSON.stringify({
      phase,
      commit,
      pid: process.pid,
      worker: process.env.VITEST_POOL_ID,
      at: Date.now(),
      remainingMs: deadline === undefined ? undefined : deadline - Date.now(),
      parallelism: availableParallelism(),
      freeBytes: freemem(),
      totalBytes: totalmem(),
      load: loadavg(),
      rssBytes: process.memoryUsage().rss,
      workerCpu: process.cpuUsage()
    })
  )
}

export async function checkoutFetchTrace() {
  if (!checkoutDiagnosticEnabled()) {
    return undefined
  }
  let directory: string
  try {
    directory = await mkdtemp(join(tmpdir(), 'orca-release-fetch-trace-'))
  } catch {
    console.error('[release-checkout-fetch]', JSON.stringify({ unavailable: true }))
    return undefined
  }
  const file = join(directory, 'events.jsonl')
  return {
    env: { ...process.env, GIT_TRACE2_EVENT: file },
    async finish(commit: string, phase: string) {
      const fetches = new Set<string>()
      let fetchMs = 0
      let fetchStarts = 0
      let fetchExits = 0
      try {
        const trace = await open(file, 'r')
        try {
          for await (const line of trace.readLines()) {
            let event: unknown
            try {
              event = JSON.parse(line)
            } catch {
              continue
            }
            if (!event || typeof event !== 'object' || !('event' in event)) {
              continue
            }
            const key =
              'sid' in event && typeof event.sid === 'string' && 'child_id' in event
                ? `${event.sid}:${String(event.child_id)}`
                : ''
            if (
              event.event === 'child_start' &&
              'argv' in event &&
              Array.isArray(event.argv) &&
              event.argv.includes('fetch')
            ) {
              fetches.add(key)
              fetchStarts++
            }
            if (event.event === 'child_exit' && fetches.has(key)) {
              fetchExits++
              if ('t_rel' in event && typeof event.t_rel === 'number') {
                fetchMs += event.t_rel * 1000
              }
            }
          }
        } finally {
          await trace.close()
        }
        console.error(
          '[release-checkout-fetch]',
          JSON.stringify({
            commit,
            phase,
            pid: process.pid,
            fetchStarts,
            fetchExits,
            fetchMs: Math.round(fetchMs)
          })
        )
      } catch {
        console.error(
          '[release-checkout-fetch]',
          JSON.stringify({ commit, phase, unavailable: true })
        )
      } finally {
        try {
          await rm(directory, { recursive: true, force: true })
        } catch {
          console.error('[release-checkout-fetch]', JSON.stringify({ cleanupFailed: true }))
        }
      }
    }
  }
}
