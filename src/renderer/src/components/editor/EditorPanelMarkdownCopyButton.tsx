import { useCallback, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

type EditorPanelMarkdownCopyButtonProps = {
  canCopy: boolean
  onCopy: () => Promise<boolean>
}

export function EditorPanelMarkdownCopyButton({
  canCopy,
  onCopy
}: EditorPanelMarkdownCopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  const mountedRef = useRef(false)
  const clearCopiedResetTimer = useCallback((): void => {
    if (copiedResetTimerRef.current === null) {
      return
    }
    window.clearTimeout(copiedResetTimerRef.current)
    copiedResetTimerRef.current = null
  }, [])
  const setButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      mountedRef.current = node !== null
      if (node === null) {
        clearCopiedResetTimer()
      }
    },
    [clearCopiedResetTimer]
  )
  const handleCopy = useCallback((): void => {
    void onCopy().then((didCopy) => {
      if (!didCopy || !mountedRef.current) {
        return
      }
      clearCopiedResetTimer()
      setCopied(true)
      copiedResetTimerRef.current = window.setTimeout(() => {
        copiedResetTimerRef.current = null
        setCopied(false)
      }, 1500)
    })
  }, [clearCopiedResetTimer, onCopy])
  const label = canCopy
    ? translate('auto.components.editor.EditorPanelHeader.copyMarkdown', 'Copy markdown')
    : translate(
        'auto.components.editor.EditorPanelHeader.copyMarkdownUnavailable',
        'Markdown is not ready to copy'
      )

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            ref={setButtonRef}
            type="button"
            className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
            onClick={handleCopy}
            disabled={!canCopy}
            aria-label={label}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
