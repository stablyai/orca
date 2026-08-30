import { useEffect } from 'react'
import { LoaderCircle, Paperclip } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { PaperclipIssue } from '../../../../../shared/paperclip-types'
import { translate } from '@/i18n/i18n'

export function PaperclipIssueList({
  connected,
  issues,
  loading,
  error,
  onLoad,
  onUse
}: {
  connected: boolean
  issues: readonly PaperclipIssue[]
  loading: boolean
  error: string | null
  onLoad: () => void
  onUse: (issue: PaperclipIssue) => void
}): React.JSX.Element {
  useEffect(() => {
    if (connected) {
      onLoad()
    }
  }, [connected, onLoad])

  if (!connected) {
    return (
      <div className="m-auto max-w-md rounded-lg border border-border/60 bg-muted/20 p-6 text-center">
        <Paperclip className="mx-auto mb-3 size-6 text-muted-foreground" />
        <p className="text-sm font-medium">
          {translate(
            'auto.components.paperclipIssueList.connect',
            'Connect Paperclip in Settings → Integrations.'
          )}
        </p>
      </div>
    )
  }
  if (loading && issues.length === 0) {
    return <LoaderCircle className="m-auto size-5 animate-spin text-muted-foreground" />
  }
  return (
    <div className="scrollbar-sleek mt-3 min-h-0 flex-1 overflow-auto rounded-md border border-border/50">
      {error ? (
        <p className="border-b border-border/50 p-3 text-xs text-destructive">{error}</p>
      ) : null}
      {issues.map((issue) => (
        <article
          key={issue.id}
          className="flex items-start gap-3 border-b border-border/40 p-3 last:border-b-0"
        >
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground">
              {issue.identifier} · {issue.status}
            </p>
            <h3 className="truncate text-sm font-medium">{issue.title}</h3>
            {issue.description ? (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{issue.description}</p>
            ) : null}
          </div>
          <Button size="sm" variant="outline" onClick={() => onUse(issue)}>
            {translate('auto.components.paperclipIssueList.use', 'Use in workspace')}
          </Button>
        </article>
      ))}
      {!loading && issues.length === 0 ? (
        <p className="p-6 text-center text-sm text-muted-foreground">
          {translate(
            'auto.components.paperclipIssueList.empty',
            'No issues in this Paperclip project.'
          )}
        </p>
      ) : null}
    </div>
  )
}
