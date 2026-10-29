import { opendirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export const AGENT_HOOK_ENDPOINT_SWEEP_MAX_ENTRIES = 1024
const AGENT_HOOK_ENDPOINT_STALE_MS = 5 * 60 * 1000

export function sweepStaleAgentHookEndpointTemps(endpointDir: string, now = Date.now()): void {
  let directory: ReturnType<typeof opendirSync> | undefined
  try {
    directory = opendirSync(endpointDir, { bufferSize: 32 })
    const cutoff = now - AGENT_HOOK_ENDPOINT_STALE_MS
    for (let scanned = 0; scanned < AGENT_HOOK_ENDPOINT_SWEEP_MAX_ENTRIES; scanned += 1) {
      const entry = directory.readSync()
      if (entry === null) {
        break
      }
      if (!entry.name.startsWith('.endpoint-') || !entry.name.endsWith('.tmp')) {
        continue
      }
      const entryPath = join(endpointDir, entry.name)
      try {
        if (statSync(entryPath).mtimeMs < cutoff) {
          unlinkSync(entryPath)
        }
      } catch {
        // best-effort sweep
      }
    }
  } catch {
    // Endpoint publication must still proceed on exotic filesystems.
  } finally {
    try {
      directory?.closeSync()
    } catch {
      // already closed
    }
  }
}
