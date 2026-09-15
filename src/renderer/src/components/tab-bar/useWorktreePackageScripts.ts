import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { joinPath } from '@/lib/path'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'
import {
  buildPackageManagerRunCommand,
  getPackageJsonField,
  parsePackageJsonScripts,
  resolvePackageManager,
  type PackageJsonScript,
  type PackageManagerName
} from '../../../../shared/package-json-scripts'

export type WorktreePackageScripts = {
  scripts: PackageJsonScript[]
  packageManager: PackageManagerName
  /** Terminal command that runs the named script with the resolved manager. */
  runCommandFor: (scriptName: string) => string
  /** Re-read package.json (e.g. when the picker opens) to catch on-disk edits. */
  refresh: () => void
}

const EMPTY_SCRIPTS: PackageJsonScript[] = []

function isMissingFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /ENOENT|no such file|not found/i.test(message)
}

async function readWorktreePackageScripts(
  worktreePath: string,
  connectionId: string | undefined
): Promise<{ scripts: PackageJsonScript[]; packageManager: PackageManagerName } | null> {
  let packageJsonContent: string
  try {
    const result = await window.api.fs.readFile({
      filePath: joinPath(worktreePath, 'package.json'),
      connectionId
    })
    if (result.isBinary) {
      return null
    }
    packageJsonContent = result.content
  } catch (error) {
    // Why: no package.json (or an unreadable one) simply means "not a node
    // project" for this feature — surface an empty result, not an error.
    if (isMissingFileError(error)) {
      return null
    }
    return null
  }

  const scripts = parsePackageJsonScripts(packageJsonContent)
  if (scripts.length === 0) {
    return null
  }

  let lockfileNames: string[] = []
  try {
    const entries = await window.api.fs.readDir({ dirPath: worktreePath, connectionId })
    lockfileNames = entries.map((entry) => entry.name)
  } catch {
    // Why: lockfile detection is best-effort; fall back to the packageManager
    // field or npm when the directory listing fails.
    lockfileNames = []
  }

  const packageManager = resolvePackageManager(
    getPackageJsonField(packageJsonContent, 'packageManager'),
    lockfileNames
  )
  return { scripts, packageManager }
}

/**
 * Read the focused worktree's package.json `scripts` block for the tab-bar
 * "Run Script" picker. Returns null while loading or when the worktree has no
 * runnable scripts, so callers can hide the button entirely.
 */
export function useWorktreePackageScripts(worktreeId: string): WorktreePackageScripts | null {
  const worktreePath = useAppStore(
    (s) => findWorktreeById(s.worktreesByRepo ?? {}, worktreeId)?.path
  )
  const repoId = useMemo(() => {
    const state = useAppStore.getState()
    const worktree = findWorktreeById(state.worktreesByRepo ?? {}, worktreeId)
    return worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  }, [worktreeId])
  const connectionId = useAppStore((s) => s.repos.find((r) => r.id === repoId)?.connectionId)

  const [state, setState] = useState<{
    scripts: PackageJsonScript[]
    packageManager: PackageManagerName
  } | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (!worktreePath) {
      setState(null)
      return
    }
    const requestId = ++requestIdRef.current
    let cancelled = false
    void readWorktreePackageScripts(worktreePath, connectionId ?? undefined).then((result) => {
      if (cancelled || requestId !== requestIdRef.current) {
        return
      }
      setState(result)
    })
    return () => {
      cancelled = true
    }
  }, [worktreePath, connectionId, reloadToken])

  const refresh = useCallback(() => setReloadToken((token) => token + 1), [])

  return useMemo(() => {
    if (!state) {
      return null
    }
    return {
      scripts: state.scripts ?? EMPTY_SCRIPTS,
      packageManager: state.packageManager,
      runCommandFor: (scriptName: string) =>
        buildPackageManagerRunCommand(state.packageManager, scriptName),
      refresh
    }
  }, [state, refresh])
}
