import { useCallback, useEffect, useRef, useState } from 'react'
import type { FsChangedPayload } from '../../../../shared/types'
import { joinPath } from './remote-file-browser-helpers'
import type { PackageScripts } from './script-runner-types'

/**
 * Pick the package manager for a worktree from the lockfile it ships.
 *
 * Falls back to npm when no lockfile is present, matching what a fresh
 * `npm run` would do in that directory.
 */
export async function detectPackageManager(worktreePath: string): Promise<'pnpm' | 'yarn' | 'npm'> {
  const pnpmExists = await window.api.shell.pathExists(joinPath(worktreePath, 'pnpm-lock.yaml'))
  if (pnpmExists) {
    return 'pnpm'
  }
  const yarnExists = await window.api.shell.pathExists(joinPath(worktreePath, 'yarn.lock'))
  if (yarnExists) {
    return 'yarn'
  }
  return 'npm'
}

/**
 * Read the `scripts` map from a worktree's package.json and keep it current.
 *
 * Re-reads whenever the watcher reports a package.json write for the same
 * worktree, so scripts added on disk show up without a restart. Returns null
 * scripts when the file is missing or unparseable.
 */
export function usePackageScripts(worktreePath: string | null): {
  scripts: PackageScripts | null
  loading: boolean
} {
  const [scripts, setScripts] = useState<PackageScripts | null>(null)
  const [loading, setLoading] = useState(false)
  // Why: reads are async, so a slow response for a previous worktree can land
  // after the user has switched. Only the newest request may touch state, or
  // the panel would offer another repo's scripts.
  const requestIdRef = useRef(0)

  const fetchScripts = useCallback(async () => {
    if (!worktreePath) {
      requestIdRef.current++
      setScripts(null)
      setLoading(false)
      return
    }
    const requestId = ++requestIdRef.current
    setLoading(true)
    try {
      const { content } = await window.api.fs.readFile({
        filePath: joinPath(worktreePath, 'package.json')
      })
      const pkg = JSON.parse(content)
      if (requestId === requestIdRef.current) {
        setScripts(pkg.scripts ?? null)
      }
    } catch {
      if (requestId === requestIdRef.current) {
        setScripts(null)
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false)
      }
    }
  }, [worktreePath])

  useEffect(() => {
    void fetchScripts()
  }, [fetchScripts])

  useEffect(() => {
    if (!worktreePath) {
      return
    }

    const unsubscribe = window.api.fs.onFsChanged((payload: FsChangedPayload) => {
      if (payload.worktreePath !== worktreePath) {
        return
      }
      const touchesPackageJson = payload.events.some((e) => e.absolutePath.endsWith('package.json'))
      if (touchesPackageJson) {
        void fetchScripts()
      }
    })

    return unsubscribe
  }, [worktreePath, fetchScripts])

  return { scripts, loading }
}
