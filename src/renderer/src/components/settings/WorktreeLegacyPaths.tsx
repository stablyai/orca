import { useState } from 'react'
import { X } from 'lucide-react'
import type { Repo } from '../../../../shared/repo-types'
import { isWorktreeCopyPath } from '../../../../shared/worktree-copy-paths'
import { getRuntimeGitIgnoredPaths } from '../../runtime/runtime-git-status-client'
import { worktreeCopyContext } from './worktree-copy-context'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

export function WorktreeLegacyPaths({
  repo,
  updateRepo
}: {
  repo: Repo
  updateRepo: (
    id: string,
    updates: Partial<Repo> | ((repo: Repo) => Partial<Repo>)
  ) => void | Promise<boolean>
}): React.JSX.Element | null {
  const [converting, setConverting] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  if (!repo.symlinkPaths?.length) {
    return null
  }

  const convert = async (): Promise<void> => {
    if (!converting) {
      return
    }
    setSaving(true)
    try {
      const ignored = await getRuntimeGitIgnoredPaths(worktreeCopyContext(repo), [converting])
      if (!isWorktreeCopyPath(converting) || !ignored.includes(converting)) {
        setError(
          translate(
            'worktreeCopies.legacyIneligible',
            'This path cannot be converted: copies require a literal path ignored by Git. The legacy entry is unchanged.'
          )
        )
        return
      }
      const saved = await updateRepo(repo.id, (current) => ({
        worktreeCopyPaths: [...new Set([...(current.worktreeCopyPaths ?? []), converting])],
        symlinkPaths: current.symlinkPaths?.filter((p) => p !== converting)
      }))
      if (saved === false) {
        setError(
          translate(
            'worktreeCopies.saveFailed',
            'Could not save these paths. Check the connection and update the Orca host if needed.'
          )
        )
        return
      }
      setConverting(null)
    } catch {
      setError(
        translate(
          'worktreeCopies.validationFailed',
          'Could not validate this path on its host. Check the connection and try again.'
        )
      )
    } finally {
      setSaving(false)
    }
  }
  const removeLegacy = async (path: string): Promise<void> => {
    setSaving(true)
    try {
      if (
        (await updateRepo(repo.id, (current) => ({
          symlinkPaths: current.symlinkPaths?.filter((p) => p !== path)
        }))) === false
      ) {
        setError(
          translate(
            'worktreeCopies.saveFailed',
            'Could not save these paths. Check the connection and update the Orca host if needed.'
          )
        )
      }
    } catch {
      setError(
        translate(
          'worktreeCopies.saveFailed',
          'Could not save these paths. Check the connection and update the Orca host if needed.'
        )
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-2 border-t border-border pt-4">
      <h4 className="text-sm font-medium">{translate('worktreeCopies.legacy', 'Legacy paths')}</h4>
      <p className="text-xs text-muted-foreground">
        {translate(
          'worktreeCopies.legacyDescription',
          'These older settings may share edits with the primary checkout. Switch to copies to keep future worktrees independent.'
        )}
      </p>
      {repo.symlinkPaths.map((path) => (
        <div key={path} className="flex flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all text-xs">{path}</code>
          <Button
            size="sm"
            variant="outline"
            disabled={saving}
            onClick={() => {
              setConverting(path)
              setError('')
            }}
          >
            {translate('worktreeCopies.convert', 'Use copies…')}
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={saving}
            aria-label={translate('worktreeCopies.removeLegacy', 'Remove legacy {{path}}', {
              path
            })}
            onClick={() => void removeLegacy(path)}
          >
            <X className="size-3" />
          </Button>
        </div>
      ))}
      {converting && (
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs">
            {translate(
              'worktreeCopies.confirm',
              'Move {{path}} to your copy list? It must be ignored by Git. Future worktrees will copy it or report why they cannot; existing worktrees stay unchanged.',
              { path: converting }
            )}
          </p>
          <Button size="sm" disabled={saving} onClick={() => void convert()}>
            {translate('worktreeCopies.confirmConvert', 'Copy in future worktrees')}
          </Button>
          <Button size="sm" variant="ghost" disabled={saving} onClick={() => setConverting(null)}>
            {translate('worktreeCopies.cancel', 'Cancel')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
