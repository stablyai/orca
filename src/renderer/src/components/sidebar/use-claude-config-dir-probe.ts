import { useEffect, useState } from 'react'
import { parseClaudeConfigDirBinding } from '../../../../shared/claude-home-binding'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  getClaudeConfigDirCredentialsPath,
  type ClaudeConfigDirProbe
} from './claude-config-dir-advice'

const PROBE_DEBOUNCE_MS = 250

/**
 * Advisory-only existence check for a draft directory. Null means "nothing to say yet" — the draft
 * is not a binding, the probe has not answered, or the group lives on another host — never
 * "looks fine".
 *
 * Deliberately `shell.pathExists`, not `fs.pathExists`: the latter is sandboxed to the workspace
 * roots and rejects any Claude home outside them. It is also local-only, so a group owned by any
 * other execution host is left unprobed rather than answered from the client's filesystem, where
 * the same path means something else entirely. The gate reads the *resolved* host, never a raw
 * ownership field — `src/shared/execution-host.ts` documents why the raw read answers "local" for
 * a row stamped only with `executionHostId`.
 */
export function useClaudeConfigDirProbe(args: {
  enabled: boolean
  draft: string
  executionHostId: ExecutionHostId
}): ClaudeConfigDirProbe | null {
  const { enabled, draft, executionHostId } = args
  const configDir =
    enabled && executionHostId === LOCAL_EXECUTION_HOST_ID
      ? parseClaudeConfigDirBinding(draft)
      : null
  const [probe, setProbe] = useState<{ configDir: string; result: ClaudeConfigDirProbe } | null>(
    null
  )

  useEffect(() => {
    if (!configDir) {
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const pathExists = window.api?.shell?.pathExists
          if (!pathExists) {
            return
          }
          const [directoryExists, signedIn] = await Promise.all([
            pathExists(configDir),
            pathExists(getClaudeConfigDirCredentialsPath(configDir))
          ])
          if (!cancelled) {
            setProbe({ configDir, result: { directoryExists, signedIn } })
          }
        } catch {
          // Why swallow: the probe is advisory, so a failed read must not surface as a verdict
          // about the directory. Silence reads as "nothing to say".
        }
      })()
    }, PROBE_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [configDir])

  // Why match on the path: a stale answer for the previous draft would advise about a directory
  // the user is no longer naming.
  return probe && probe.configDir === configDir ? probe.result : null
}
