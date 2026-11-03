import React, { useCallback, useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { commitRuntimeGit } from '@/runtime/runtime-git-sync-client'
import type { RuntimeGitContext } from '@/runtime/runtime-git-client-context'
import { CommitMessageComposer } from '../commit/commit-message-composer'

type Props = {
  context: RuntimeGitContext
  repoName: string
  stagedCount: number
  hasUnresolvedConflicts: boolean
  onCommitted: () => void
}

/** Commit staged changes in a linked repo without leaving this workspace's panel. */
export function LinkedRepoCommitBox({
  context,
  repoName,
  stagedCount,
  hasUnresolvedConflicts,
  onCommitted
}: Props): React.JSX.Element {
  const [message, setMessage] = useState('')
  const [isCommitting, setIsCommitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errorId = `linked-commit-error-${context.worktreeId}`
  const canCommit =
    !isCommitting && stagedCount > 0 && !hasUnresolvedConflicts && message.trim().length > 0

  const commit = useCallback(async () => {
    const submitted = message.trim()
    if (!canCommit) {
      return
    }
    setIsCommitting(true)
    setError(null)
    try {
      const result = await commitRuntimeGit(context, submitted)
      if (!result.success) {
        setError(
          result.error ??
            translate(
              'auto.components.right.sidebar.SourceControl.linkedReposCommitFailed',
              'Commit failed'
            )
        )
        return
      }
      // Keep edits typed while the commit ran.
      setMessage((current) => (current.trim() === submitted ? '' : current))
      onCommitted()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setIsCommitting(false)
    }
  }, [canCommit, context, message, onCommitted])

  return (
    <div
      className="px-4 pb-2"
      data-testid="source-control-linked-commit"
      onKeyDown={(event) => {
        if (canCommit && isScreenSubmitShortcut(event)) {
          event.preventDefault()
          event.stopPropagation()
          void commit()
        }
      }}
    >
      <CommitMessageComposer
        rows={2}
        commitMessage={message}
        disabled={isCommitting}
        onCommitMessageChange={setMessage}
        describedBy={error ? errorId : ''}
        showGenerate={false}
        isGenerating={false}
        onCancelGenerate={() => {}}
        isGenerateDisabled
        onGenerate={() => {}}
      />
      <Button
        type="button"
        size="xs"
        className="mt-1 w-full"
        disabled={!canCommit}
        onClick={() => void commit()}
        title={translate(
          'auto.components.right.sidebar.SourceControl.linkedReposCommitTitle',
          'Commit staged changes in {{repo}}',
          { repo: repoName }
        )}
      >
        {isCommitting ? (
          <RefreshCw className="size-3.5 animate-spin" />
        ) : (
          <Check className="size-3.5" />
        )}
        {translate('auto.components.right.sidebar.SourceControl.linkedReposCommit', 'Commit')}
      </Button>
      {error && (
        <div id={errorId} role="alert" className="mt-1 text-[11px] text-destructive/80 break-words">
          {error}
        </div>
      )}
    </div>
  )
}
