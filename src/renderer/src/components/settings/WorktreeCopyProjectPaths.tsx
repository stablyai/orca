import { worktreeCopyContext } from './worktree-copy-context'
import { useEffect, useState } from 'react'
import { getRepoMainWorktreeId } from '../../../../shared/worktree/id'
import { parseWorktreeIncludeFile } from '../../../../shared/worktree-copy-paths'
import type { Repo } from '../../../../shared/repo-types'
import { readRuntimeDirectory, readRuntimeFileContent } from '../../runtime/runtime-file-client'
import { joinPath } from '../../lib/path'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

export function WorktreeCopyProjectPaths({ repo }: { repo: Repo }): React.JSX.Element {
  const [result, setResult] = useState<{
    paths: string[]
    exists: boolean
    error?: string
  }>()
  const openFile = useAppStore((s) => s.openFile)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const setActiveView = useAppStore((s) => s.setActiveView)
  const worktreeId = getRepoMainWorktreeId(repo)
  const filePath = joinPath(repo.path, '.worktreeinclude')

  useEffect(() => {
    let cancelled = false
    const context = worktreeCopyContext(repo)
    void readRuntimeDirectory(context, repo.path)
      .then(async (entries) => {
        const exists = entries.some((entry) => entry.name === '.worktreeinclude')
        const file = exists
          ? await readRuntimeFileContent({ ...context, filePath, relativePath: '.worktreeinclude' })
          : null
        if (!cancelled) {
          setResult({
            exists,
            paths: file && !file.isBinary ? parseWorktreeIncludeFile(file.content) : []
          })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResult({
            exists: false,
            paths: [],
            error: translate(
              'worktreeCopies.projectUnavailable',
              'Could not read the project list from this host.'
            )
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [repo, filePath])

  return (
    <div className="space-y-2 border-t border-border px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <h4 className="font-mono text-xs font-medium">
          {translate('worktreeCopies.project', '.worktreeinclude')}
        </h4>
        {result?.exists && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              setActiveWorktree(worktreeId)
              openFile({
                filePath,
                relativePath: '.worktreeinclude',
                worktreeId,
                language: 'plaintext',
                mode: 'edit'
              })
              setActiveView('terminal')
            }}
          >
            {translate('worktreeCopies.openProject', 'Open file')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'worktreeCopies.projectDescription',
          'Added by the project. Edit this file to change these paths.'
        )}
      </p>
      {result?.error ? (
        <p role="status" className="text-xs text-muted-foreground">
          {result.error}
        </p>
      ) : (
        <p className="break-words font-mono text-xs">
          {result
            ? result.paths.join(' · ') ||
              translate('worktreeCopies.noProject', 'No project paths listed.')
            : translate('worktreeCopies.loading', 'Reading project list…')}
        </p>
      )}
    </div>
  )
}
