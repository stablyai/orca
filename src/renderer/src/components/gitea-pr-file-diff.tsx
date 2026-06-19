/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: the file's
   diff content is loaded from Gitea IPC, so local state resets when the file or
   commit shas change. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { DiffEditor } from '@monaco-editor/react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { detectLanguage } from '@/lib/language-detect'
import { cn } from '@/lib/utils'
import { GiteaPrLineComments } from '@/components/gitea-pr-line-comments'
import type { GiteaPRFile, GiteaPRFileContents, GiteaPRReviewComment } from '../../../shared/types'
import type { GiteaIssueScope } from '@/store/slices/gitea'
import { translate } from '@/i18n/i18n'

type GiteaPrFileDiffProps = {
  file: GiteaPRFile
  scope: GiteaIssueScope
  baseSha: string
  headSha: string
  isDark: boolean
  sideBySide: boolean
  reviewComments: GiteaPRReviewComment[]
  onAddReviewComment: (path: string, line: number, body: string) => Promise<boolean>
}

const STATUS_LABELS: Record<GiteaPRFile['status'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  changed: 'Changed'
}

export function GiteaPrFileDiff({
  file,
  scope,
  baseSha,
  headSha,
  isDark,
  sideBySide,
  reviewComments,
  onAddReviewComment
}: GiteaPrFileDiffProps): React.JSX.Element {
  const [contents, setContents] = useState<GiteaPRFileContents | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const requestRef = useRef(0)

  const load = useCallback(() => {
    requestRef.current += 1
    const requestId = requestRef.current
    setLoading(true)
    setError(false)
    void (
      window.api.gitea.prFileContents({
        repoPath: scope.repoPath,
        repoId: scope.repoId ?? null,
        sourceContext: scope.sourceContext ?? null,
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        baseSha,
        headSha
      }) as Promise<GiteaPRFileContents>
    )
      .then((result) => {
        if (requestId === requestRef.current) {
          setContents(result)
        }
      })
      .catch(() => {
        // Why: surface the failure instead of silently leaving an empty diff.
        if (requestId === requestRef.current) {
          setContents(null)
          setError(true)
          toast.error(
            translate('auto.components.gitea.pr.file.diff.f1a2b3c4d5', 'Failed to load file diff.')
          )
        }
      })
      .finally(() => {
        if (requestId === requestRef.current) {
          setLoading(false)
        }
      })
  }, [file.path, file.oldPath, file.status, scope, baseSha, headSha])

  useEffect(() => {
    load()
  }, [load])

  const isBinary = Boolean(contents?.originalIsBinary || contents?.modifiedIsBinary)

  return (
    <div className="overflow-hidden rounded-md border border-border/50">
      <div className="flex items-center gap-2 border-b border-border/50 bg-muted/40 px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ` : ''}
          {file.path}
        </span>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {STATUS_LABELS[file.status]}
        </span>
        {file.additions > 0 ? (
          <span className="shrink-0 text-[11px] text-status-success">+{file.additions}</span>
        ) : null}
        {file.deletions > 0 ? (
          <span className="shrink-0 text-[11px] text-destructive">−{file.deletions}</span>
        ) : null}
      </div>
      <div className={cn('h-[420px]', isBinary && 'h-auto')}>
        {loading ? (
          <div className="flex h-[420px] items-center justify-center text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex h-[420px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <span>
              {translate(
                'auto.components.gitea.pr.file.diff.f1a2b3c4d5',
                'Failed to load file diff.'
              )}
            </span>
            <Button size="sm" variant="outline" onClick={load}>
              {translate('auto.components.gitea.pr.file.diff.e6f7a8b9c0', 'Retry')}
            </Button>
          </div>
        ) : isBinary ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            {translate('auto.components.gitea.pr.file.diff.81e07de6a5', 'Binary file not shown.')}
          </p>
        ) : (
          <DiffEditor
            height="420px"
            language={detectLanguage(file.path)}
            original={contents?.original ?? ''}
            modified={contents?.modified ?? ''}
            theme={isDark ? 'vs-dark' : 'vs'}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            options={{
              readOnly: true,
              originalEditable: false,
              renderSideBySide: sideBySide,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbers: 'on',
              automaticLayout: true,
              renderOverviewRuler: false,
              hideUnchangedRegions: { enabled: true }
            }}
          />
        )}
      </div>
      <GiteaPrLineComments
        comments={reviewComments}
        onAdd={(line, body) => onAddReviewComment(file.path, line, body)}
      />
    </div>
  )
}
