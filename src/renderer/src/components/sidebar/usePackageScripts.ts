import { useCallback, useEffect, useState } from 'react'
import type { FsChangedPayload } from '../../../../shared/types'
import type { PackageScripts } from './script-runner-types'

export async function detectPackageManager(worktreePath: string): Promise<'pnpm' | 'yarn' | 'npm'> {
  const pnpmExists = await window.api.shell.pathExists(`${worktreePath}/pnpm-lock.yaml`)
  if (pnpmExists) {
    return 'pnpm'
  }
  const yarnExists = await window.api.shell.pathExists(`${worktreePath}/yarn.lock`)
  if (yarnExists) {
    return 'yarn'
  }
  return 'npm'
}

export function usePackageScripts(worktreePath: string | null): {
  scripts: PackageScripts | null
  loading: boolean
} {
  const [scripts, setScripts] = useState<PackageScripts | null>(null)
  const [loading, setLoading] = useState(false)

  const fetchScripts = useCallback(async () => {
    if (!worktreePath) {
      setScripts(null)
      return
    }
    setLoading(true)
    try {
      const { content } = await window.api.fs.readFile({
        filePath: `${worktreePath}/package.json`
      })
      const pkg = JSON.parse(content)
      setScripts(pkg.scripts ?? null)
    } catch {
      setScripts(null)
    } finally {
      setLoading(false)
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
