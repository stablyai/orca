import { useState } from 'react'
import { LoaderCircle, MessageSquarePlus, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { GiteaPRReviewComment } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

type GiteaPrLineCommentsProps = {
  comments: GiteaPRReviewComment[]
  onAdd: (line: number, body: string) => Promise<boolean>
}

// Diff-anchored review comments for a single file: shows existing comments
// grouped by line and a compact composer to add one on a given line.
export function GiteaPrLineComments({
  comments,
  onAdd
}: GiteaPrLineCommentsProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [line, setLine] = useState('')
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const sorted = [...comments].sort((a, b) => a.line - b.line)

  const handleSubmit = async (): Promise<void> => {
    const lineNumber = Number.parseInt(line, 10)
    const trimmed = body.trim()
    if (!Number.isInteger(lineNumber) || lineNumber <= 0 || !trimmed || submitting) {
      return
    }
    setSubmitting(true)
    const ok = await onAdd(lineNumber, trimmed)
    setSubmitting(false)
    if (ok) {
      setBody('')
      setLine('')
      setOpen(false)
    }
  }

  return (
    <div className="border-t border-border/50 bg-muted/20 px-3 py-2">
      {sorted.length > 0 ? (
        <div className="mb-2 flex flex-col gap-2">
          {sorted.map((comment) => (
            <div key={comment.id} className="rounded-md border border-border/50 bg-background/60">
              <div className="flex items-center gap-2 border-b border-border/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono">
                  {translate(
                    'auto.components.gitea.pr.line.comments.489b36633a',
                    'Line {{value0}}',
                    {
                      value0: comment.line
                    }
                  )}
                </span>
                <span className="truncate font-medium text-foreground">
                  {comment.user?.login ??
                    translate('auto.components.gitea.pr.line.comments.c01a062b92', 'Unknown')}
                </span>
              </div>
              <div className="px-2.5 py-1.5">
                <CommentMarkdown content={comment.body} className="text-[12px] leading-relaxed" />
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              value={line}
              onChange={(event) => setLine(event.target.value)}
              placeholder={translate('auto.components.gitea.pr.line.comments.4e59b0c4f8', 'Line #')}
              className="h-8 w-24 text-xs"
            />
            <span className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.gitea.pr.line.comments.a43b5cc38b',
                'New-file line number from the diff'
              )}
            </span>
          </div>
          <div className="flex gap-2">
            <textarea
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={2}
              disabled={submitting}
              placeholder={translate(
                'auto.components.gitea.pr.line.comments.02339776da',
                'Review comment…'
              )}
              className="min-h-10 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
            />
            <Button
              onClick={() => void handleSubmit()}
              disabled={submitting || !body.trim() || !line.trim()}
              className="self-end gap-2"
              size="sm"
            >
              {submitting ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {translate('auto.components.gitea.pr.line.comments.317313f8af', 'Comment')}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="ghost" size="xs" onClick={() => setOpen(true)} className="gap-1.5">
          <MessageSquarePlus className="size-3.5" />
          {translate('auto.components.gitea.pr.line.comments.6cbd906d88', 'Comment on a line')}
        </Button>
      )}
    </div>
  )
}
