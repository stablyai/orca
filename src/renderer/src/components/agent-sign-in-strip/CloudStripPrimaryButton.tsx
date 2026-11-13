// The sign-in strip's primary button. One that opens a page in the browser ("Open again", "Copy
// code and open", the setup's "Open again") gets the "Copy link" chevron (Neil's rule).
import type React from 'react'
import { Button } from '@/components/ui/button'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import type { ExternalLinkSource } from '@/components/open-external/copy-external-link'
import type { CloudStripActions } from './CloudAgentSignInStrip'
import type { CloudStripModel, CloudStripPrimary } from './cloud-agent-strip-model'

/** The URL a primary opens in the browser, for its "Copy link"; null when it opens nothing. */
export function stripPrimaryLink(
  action: CloudStripPrimary,
  actions: Pick<CloudStripActions, 'linkFor'>
): ExternalLinkSource | null {
  const custom = actions.linkFor?.(action)
  if (custom) {
    return custom
  }
  return action.kind === 'openAgain' || action.kind === 'copyAndOpen' ? action.url : null
}

export function StripPrimaryButton({
  primary,
  link,
  ariaLabel,
  variant,
  quiet,
  onActivate,
  children
}: {
  primary: NonNullable<CloudStripModel['primary']>
  link: ExternalLinkSource | null
  ariaLabel?: string
  variant: 'default' | 'outline' | 'ghost'
  /** The stacked row's quiet button marks busy as unavailable only. */
  quiet?: boolean
  onActivate: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const busy = primary.busy || undefined
  const onClick = (): void => {
    if (!primary.busy) {
      onActivate()
    }
  }
  if (link && !primary.busy) {
    return (
      <OpenExternalSplitButton
        link={link}
        aria-label={ariaLabel}
        size="xs"
        variant={variant}
        onClick={onClick}
      >
        {children}
      </OpenExternalSplitButton>
    )
  }
  return (
    <Button
      type="button"
      aria-label={ariaLabel}
      size="xs"
      variant={variant}
      aria-busy={quiet ? undefined : busy}
      aria-disabled={busy}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}
