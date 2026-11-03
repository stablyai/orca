import { Check, Copy } from 'lucide-react'
import { useCallback } from 'react'
import { toast } from 'sonner'
import { useCopyFeedbackState } from '../right-sidebar/source-control/notes/copy-feedback'
import { translate } from '@/i18n/i18n'
import { describeClipboardWriteFailure } from '@/lib/clipboard-write-failure'

type Props = {
  getText: () => string
}

export function DiffCommentCopyButton({ getText }: Props): React.JSX.Element {
  const [copied, showCopied] = useCopyFeedbackState(false)

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(getText())
      showCopied(true)
    } catch (error) {
      // Report rejected writes so a failed copy cannot look successful until the user pastes stale text.
      toast.error(
        translate(
          'auto.components.right.sidebar.SourceControl.diffCommentNotesCopyFailed',
          'Failed to copy notes'
        ),
        { description: describeClipboardWriteFailure(error) }
      )
    }
  }, [getText, showCopied])

  const copiedLabel = translate('auto.components.editor.MarkdownPreview.94b520a96a', 'Copied note')
  const label = copied
    ? copiedLabel
    : translate('auto.components.editor.MarkdownPreview.f961e94057', 'Copy note for agent')

  return (
    <>
      <button
        type="button"
        className="orca-diff-comment-pill-btn"
        title={label}
        aria-label={label}
        onClick={(ev) => {
          ev.preventDefault()
          ev.stopPropagation()
          void handleCopy()
        }}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? copiedLabel : ''}
      </span>
    </>
  )
}
