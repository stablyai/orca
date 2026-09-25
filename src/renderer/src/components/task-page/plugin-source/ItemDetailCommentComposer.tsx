import { useRef, useState } from 'react'
import { LoaderCircle, Send } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type {
  PluginTaskComment,
  PluginTaskSourceResult
} from '../../../../../shared/plugins/plugin-task-source-contract'

/** The posting verb a source declared through `status().supports.comment`.
 *  Absent — not disabled — when it declared none. */
export type PluginTaskSourceCommentControl = {
  /** Hands back the envelope so a rejection lands beside the draft that
   *  produced it rather than in the page banner. */
  submit: (body: string) => Promise<PluginTaskSourceResult<PluginTaskComment>>
}

export function TaskPagePluginSourceCommentComposer({
  draft,
  onDraftChange,
  textareaRef,
  submit
}: PluginTaskSourceCommentControl & {
  draft: string
  onDraftChange: (draft: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const body = draft.trim()

  const post = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (inFlight.current || body === '') {
      return
    }
    inFlight.current = true
    setSubmitting(true)
    setError(null)
    const result = await submit(body)
    inFlight.current = false
    setSubmitting(false)
    // The draft survives a failure: a written comment lost to a transient
    // outage costs far more than the retry does.
    if (!result.ok) {
      setError(result.message)
      return
    }
    onDraftChange('')
  }

  return (
    <form onSubmit={(event) => void post(event)} className="mt-4 border-t border-border/40 pt-3">
      <div className="flex gap-2">
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={translate(
            'auto.components.TaskPage.pluginTaskSourceCommentPlaceholder',
            'Add a comment...'
          )}
          rows={3}
          disabled={submitting}
          className="min-h-20 flex-1"
          aria-label={translate(
            'auto.components.TaskPage.pluginTaskSourceCommentDraft',
            'Comment body'
          )}
        />
        <Button type="submit" disabled={body === '' || submitting} className="self-end">
          {submitting ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          {translate('auto.components.TaskPage.pluginTaskSourceCommentSubmit', 'Comment')}
        </Button>
      </div>
      {error ? (
        <div
          role="alert"
          className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
    </form>
  )
}
