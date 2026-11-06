import React from 'react'
import { Check, Copy } from 'lucide-react'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function CheckRunCopyButton({
  text,
  label
}: {
  text: string
  label: string
}): React.JSX.Element {
  const { canCopy, copyText, status } = useClipboardTextCopyFeedback(text)
  const accessibleLabel =
    status === 'copied'
      ? translate('auto.components.editor.CheckRunCopyButton.copied', 'Copied')
      : status === 'failed'
        ? translate('auto.components.editor.CheckRunCopyButton.failed', "Couldn't copy")
        : canCopy
          ? label
          : translate('auto.components.editor.CheckRunCopyButton.empty', 'Nothing to copy')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={accessibleLabel}
          disabled={!canCopy}
          onClick={() => void copyText()}
          className={cn(
            'text-muted-foreground',
            status === 'copied' && 'text-status-success',
            status === 'failed' && 'text-destructive'
          )}
        >
          {status === 'copied' ? <Check /> : <Copy />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {accessibleLabel}
      </TooltipContent>
    </Tooltip>
  )
}
