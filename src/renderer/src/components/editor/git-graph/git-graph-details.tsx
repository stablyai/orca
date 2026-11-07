import { useEffect, useState } from 'react'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  GitHistoryCommitFiles,
  type GitHistoryCommitFilesState
} from '@/components/right-sidebar/source-control/sync/git-history-commit-files'
import { formatGitHistoryTimestamp } from '@/components/right-sidebar/source-control/sync/git-history-format'
import type { useGitHistoryCommitActions } from '@/components/right-sidebar/source-control/sync/use-git-history-commit-actions'
import type { GitHistoryItem } from '../../../../../shared/git/history/git-history-types'
import { translate } from '@/i18n/i18n'

export function GitGraphDetails({
  item,
  actions,
  onParent
}: {
  item: GitHistoryItem
  actions: ReturnType<typeof useGitHistoryCommitActions>
  onParent: (id: string) => void
}) {
  const [files, setFiles] = useState<GitHistoryCommitFilesState>({ status: 'loading' })
  const loadFiles = actions.loadCommitFiles
  useEffect(() => {
    let live = true
    setFiles({ status: 'loading' })
    void loadFiles(item)
      .then((entries) => {
        if (live) {
          setFiles({ status: 'ready', entries })
        }
      })
      .catch((cause) => {
        if (live) {
          setFiles({ status: 'error', error: String(cause) })
        }
      })
    return () => {
      live = false
    }
  }, [item, loadFiles])
  const body = item.message.startsWith(item.subject)
    ? item.message.slice(item.subject.length).trim()
    : item.message
  return (
    <div>
      <div className="space-y-3 p-4">
        <h2 className="break-words text-sm font-semibold">{item.subject}</h2>
        {body && <p className="whitespace-pre-wrap break-words text-xs">{body}</p>}
        <div className="text-xs text-muted-foreground">
          <div>
            {item.author}
            {item.authorEmail ? ` <${item.authorEmail}>` : ''}
          </div>
          <div>{formatGitHistoryTimestamp(item.timestamp)}</div>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <span className="break-all font-mono text-2xs">{item.id}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={translate('gitGraph.copyHash', 'Copy commit hash')}
                onClick={() => actions.handleCommitAction('copy-hash', item)}
              >
                <Copy className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{translate('gitGraph.copyHash', 'Copy commit hash')}</TooltipContent>
          </Tooltip>
        </div>
        {!!item.parentIds.length && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {translate('gitGraph.parents', 'Parents')}
            </span>
            {item.parentIds.map((id) => (
              <Button key={id} variant="ghost" size="xs" onClick={() => onParent(id)}>
                <span className="font-mono text-2xs">{id.slice(0, 7)}</span>
              </Button>
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-border px-4 py-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {translate('gitGraph.files', 'Files')}
      </div>
      <GitHistoryCommitFiles
        state={files}
        onOpenFile={(entry, event) => actions.openCommitFile(item, entry, event)}
        onOpenAll={() => void actions.openHistoryCommitDiff(item)}
      />
    </div>
  )
}
