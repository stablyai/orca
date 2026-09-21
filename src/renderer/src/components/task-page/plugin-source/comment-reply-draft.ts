import { useCallback, useEffect, useRef, useState } from 'react'

import { translate } from '@/i18n/i18n'
import type { PluginTaskComment } from '../../../../../shared/plugins/plugin-task-source-contract'

function quoteBlock(comment: PluginTaskComment): string {
  const attribution = translate(
    'auto.components.TaskPage.pluginTaskSourceReplyAttribution',
    '{{value0}} wrote:',
    { value0: comment.author.displayName }
  )
  return [`**${attribution}**`, '', ...comment.body.split(/\r?\n/)]
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

/** Azure Boards has no threaded replies — its web UI quotes the original into a
 *  new top-level comment — so a reply here is a prefilled draft, not a thread.
 *  The block is appended so a second reply stacks instead of erasing the first. */
export function buildQuotedReplyDraft(draft: string, comment: PluginTaskComment): string {
  const block = quoteBlock(comment)
  const kept = draft.trimEnd()
  return kept === '' ? `${block}\n\n` : `${kept}\n\n${block}\n\n`
}

export type CommentReplyDraft = {
  draft: string
  setDraft: (draft: string) => void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  quoteReply: (comment: PluginTaskComment) => void
}

export function useCommentReplyDraft(): CommentReplyDraft {
  const [draft, setDraft] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const caretToEnd = useRef(false)

  const quoteReply = useCallback((comment: PluginTaskComment) => {
    caretToEnd.current = true
    setDraft((current) => buildQuotedReplyDraft(current, comment))
  }, [])

  // The caret has to move after the quote renders, or the user types above it.
  useEffect(() => {
    if (!caretToEnd.current) {
      return
    }
    caretToEnd.current = false
    const field = textareaRef.current
    if (!field) {
      return
    }
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }, [draft])

  return { draft, setDraft, textareaRef, quoteReply }
}
