import React from 'react'
import { Minus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogClose } from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** "@login · Not you?" on one line; the login truncates, Not you? starts over with another account. */
export function GitHubSignedInLine({
  login,
  onNotYou
}: {
  login: string
  onNotYou: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const who = `@${login}`
  const signedInAs = t('bots.connect.signedInAs', 'Signed in as {{who}}', { who })
  return (
    <span className="flex min-w-0 items-center gap-1 whitespace-nowrap">
      <span className="min-w-0 truncate" title={signedInAs}>
        <span aria-hidden>{who}</span>
        <span className="sr-only">{signedInAs}</span>
      </span>
      <span aria-hidden>·</span>
      <Button variant="link-muted" size="inlineText" onClick={onNotYou}>
        {t('bots.connect.notYou', 'Not you?')}
      </Button>
    </span>
  )
}

/** The corner button: while setup waits on GitHub in the browser it minimizes to the pill, like Escape;
 *  otherwise it ends setup, like Cancel. */
export function GitHubSetupCorner({
  minimize,
  onEnd
}: {
  minimize: boolean
  onEnd: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (!minimize) {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        className="-my-1 -mr-1.5 shrink-0"
        aria-label={t('auto.components.ui.dialog.f26c4baeda', 'Close')}
        onClick={onEnd}
      >
        <X className="size-4" />
      </Button>
    )
  }
  const label = t('auto.components.ui.dialog.minimize', 'Minimize')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DialogClose asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="-my-1 -mr-1.5 shrink-0"
            aria-label={label}
          >
            <Minus className="size-3.5" />
          </Button>
        </DialogClose>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
