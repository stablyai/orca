import { Check, Copy } from 'lucide-react'
import { useCallback } from 'react'
import { useCopyFeedbackState } from '../right-sidebar/source-control/notes/copy-feedback'
import { translate } from '@/i18n/i18n'

type Props = {
  getText: () => string
}

export function DiffCommentCopyButton({ getText }: Props): React.JSX.Element {
  const [copied, showCopied] = useCopyFeedbackState(false)

  const handleCopy = useCallback(async (): Promise<void> => {
    try {
      await window.api.ui.writeClipboardText(getText())
      showCopied(true)
    } catch {
      // Clipboard writes fail when the window lacks focus; keep the button retryable.
    }
  }, [getText, showCopied])

  const label = copied
    ? translate('auto.components.editor.MarkdownPreview.94b520a96a', 'Copied note')
    : translate('auto.components.editor.MarkdownPreview.f961e94057', 'Copy note for agent')

  return (
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
  )
}
