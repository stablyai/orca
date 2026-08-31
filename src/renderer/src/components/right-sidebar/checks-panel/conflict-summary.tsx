import React, { useCallback, useRef, useState } from 'react'
import { Check, Copy, Files } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type {
  PRConflictSummary,
  PRMergeableState
} from '../../../../../shared/github/pull-request-types'
import { translate } from '@/i18n/i18n'

export type ConflictReview = {
  mergeable: PRMergeableState
  conflictSummary?: PRConflictSummary
}

export function buildMergeabilityRecalculationCommands(): string {
  return [
    'git fetch origin',
    'git commit --allow-empty --only -m "chore: refresh PR mergeability"',
    'git push'
  ].join('\n')
}

export function ConflictingFilesSection({ pr }: { pr: ConflictReview }): React.JSX.Element | null {
  const files = pr.conflictSummary?.files ?? []
  if (pr.mergeable !== 'CONFLICTING' || files.length === 0) {
    return null
  }

  // Why: the resolve action lives in the triage strip above; this section is
  // purely the informational conflict file list so the action isn't duplicated.
  return (
    <div className="border-b border-border px-3 py-3">
      <div className="text-[11px] text-muted-foreground">
        {pr.conflictSummary!.commitsBehind}{' '}
        {translate('auto.components.right.sidebar.checks.panel.content.6fa7f8723f', 'commit')}
        {pr.conflictSummary!.commitsBehind === 1 ? '' : 's'}{' '}
        {translate(
          'auto.components.right.sidebar.checks.panel.content.3916814392',
          'behind (base commit:'
        )}{' '}
        <span className="font-mono text-[10px]">{pr.conflictSummary!.baseCommit}</span>)
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Files className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.checks.panel.content.0975eeaaef',
            'Conflicting files'
          )}
        </div>
      </div>
      <div className="mt-2 space-y-1.5">
        {files.map((filePath) => (
          <div
            key={filePath}
            className="rounded-md border border-border bg-accent/20 px-2.5 py-1.5"
          >
            <div className="break-all font-mono text-[11px] leading-4 text-foreground">
              {filePath}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Fallback shown when the hosted review reports merge conflicts but no file list is available yet. */
export function MergeConflictNotice({
  pr,
  isRefreshingConflictDetails
}: {
  pr: ConflictReview
  isRefreshingConflictDetails: boolean
}): React.JSX.Element | null {
  if (pr.mergeable !== 'CONFLICTING' || (pr.conflictSummary?.files.length ?? 0) > 0) {
    return null
  }
  const locallyClean = pr.conflictSummary?.localMergeState === 'clean'
  let noticeBody = translate(
    'auto.components.right.sidebar.checks.panel.content.ae8a04ef17',
    'Conflict file details are unavailable'
  )
  if (isRefreshingConflictDetails) {
    noticeBody = translate(
      'auto.components.right.sidebar.checks.panel.content.73d0675356',
      'Refreshing conflict details…'
    )
  } else if (locallyClean) {
    noticeBody = translate(
      'auto.components.right.sidebar.checks.panel.content.f5bc5c4cf1',
      'The hosting provider reports conflicts, but local Git did not reproduce them. Refresh the review or push the branch to recalculate mergeability.'
    )
  }
  const refreshCommands = locallyClean ? buildMergeabilityRecalculationCommands() : null

  return (
    <div className="border-t border-border px-3 py-3">
      <div className="text-[11px] font-medium text-foreground">
        {translate(
          'auto.components.right.sidebar.checks.panel.content.87cd07c69a',
          'This branch has conflicts that must be resolved'
        )}
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">{noticeBody}</div>
      {refreshCommands ? <MergeabilityRecalculationCommandBox commands={refreshCommands} /> : null}
    </div>
  )
}

function MergeabilityRecalculationCommandBox({
  commands
}: {
  commands: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  const isMountedRef = useRef(false)

  const clearCopiedResetTimer = useCallback((): void => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current)
      copiedResetTimerRef.current = null
    }
  }, [])

  const setCopyButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      isMountedRef.current = node !== null
      if (node === null) {
        clearCopiedResetTimer()
      }
    },
    [clearCopiedResetTimer]
  )

  const copyCommands = useCallback((): void => {
    void window.api.ui
      .writeClipboardText(commands)
      .then(() => {
        if (!isMountedRef.current) {
          return
        }
        clearCopiedResetTimer()
        setCopied(true)
        copiedResetTimerRef.current = window.setTimeout(() => {
          copiedResetTimerRef.current = null
          setCopied(false)
        }, 1500)
      })
      .catch(() => {
        /* best-effort */
      })
  }, [clearCopiedResetTimer, commands])

  return (
    <div className="mt-3 rounded-md border border-border bg-accent/20 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-medium text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.checks.panel.content.5bc9bda2af',
            'Run from this worktree'
          )}
        </div>
        <Button
          ref={setCopyButtonRef}
          type="button"
          variant="outline"
          size="xs"
          onClick={copyCommands}
          aria-label={translate(
            'auto.components.right.sidebar.checks.panel.content.e87fb3d929',
            'Copy mergeability refresh commands'
          )}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied
            ? translate('auto.components.right.sidebar.checks.panel.content.1e53e45072', 'Copied')
            : translate(
                'auto.components.right.sidebar.checks.panel.content.084c516efb',
                'Copy commands'
              )}
        </Button>
      </div>
      <pre className="scrollbar-sleek mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[10px] leading-4 text-foreground">
        {commands}
      </pre>
    </div>
  )
}
