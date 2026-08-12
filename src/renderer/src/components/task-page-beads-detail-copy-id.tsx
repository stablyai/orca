import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

/** Breadcrumb-strip copy button for the beads issue id, with the transient copied check. */
export function BeadsIssueIdCopyButton({ issueId }: { issueId: string }): React.JSX.Element {
  const [idCopied, setIdCopied] = useState(false)
  const idCopiedResetTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (idCopiedResetTimerRef.current !== null) {
        window.clearTimeout(idCopiedResetTimerRef.current)
      }
    },
    []
  )

  const handleCopyIssueId = useCallback(async (): Promise<void> => {
    const idLabel = translate('auto.components.TaskPage.eb10c32872', 'ID')
    try {
      await window.api.ui.writeClipboardText(issueId)
      if (idCopiedResetTimerRef.current !== null) {
        window.clearTimeout(idCopiedResetTimerRef.current)
      }
      setIdCopied(true)
      idCopiedResetTimerRef.current = window.setTimeout(() => {
        idCopiedResetTimerRef.current = null
        setIdCopied(false)
      }, 1500)
      toast.success(
        translate('auto.components.TaskPage.beadsCopySuccess', '{{value0}} copied', {
          value0: idLabel
        })
      )
    } catch {
      toast.error(
        translate('auto.components.TaskPage.beadsCopyFailure', 'Failed to copy {{value0}}', {
          value0: idLabel.toLowerCase()
        })
      )
    }
  }, [issueId])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => void handleCopyIssueId()}
          aria-label={translate('auto.components.TaskPage.beadsCopyId', 'Copy ID')}
        >
          {idCopied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {idCopied
          ? translate('auto.components.GitHubItemDialog.038b3d39b1', 'Copied')
          : translate('auto.components.TaskPage.beadsCopyId', 'Copy ID')}
      </TooltipContent>
    </Tooltip>
  )
}
