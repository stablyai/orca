import { useCallback, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/**
 * Header affordance that copies the review-comment resolution prompt to the clipboard so
 * the user can paste it into an agent they already have open. Copy→Check icon-swap on success.
 */
export function CopyCommentsPromptButton({
  label,
  disabled,
  disabledReason,
  onCopy
}: {
  label: string
  disabled?: boolean
  disabledReason?: string
  onCopy: () => Promise<boolean>
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)
  // Why: clipboard IPC can resolve after unmount; the ref lets the callback skip the post-unmount setState.
  const isMountedRef = useRef(false)

  const setButtonRef = useCallback((node: HTMLButtonElement | null) => {
    isMountedRef.current = node !== null
    if (node === null && resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
  }, [])

  const handleCopy = useCallback(async () => {
    const ok = await onCopy()
    if (!ok || !isMountedRef.current) {
      return
    }
    setCopied(true)
    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current)
    }
    resetTimerRef.current = window.setTimeout(() => {
      resetTimerRef.current = null
      setCopied(false)
    }, 1500)
  }, [onCopy])

  const copiedLabel = translate(
    'auto.components.right.sidebar.pr.comments.copy.prompt.button.a1f3c2d4e5',
    'Copied prompt to clipboard'
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={setButtonRef}
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground hover:text-foreground"
          aria-label={label}
          disabled={disabled}
          title={disabled ? disabledReason : undefined}
          onClick={() => void handleCopy()}
        >
          {copied ? <Check className="size-3 text-status-success" /> : <Copy className="size-3" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {disabled && disabledReason ? disabledReason : copied ? copiedLabel : label}
      </TooltipContent>
    </Tooltip>
  )
}
