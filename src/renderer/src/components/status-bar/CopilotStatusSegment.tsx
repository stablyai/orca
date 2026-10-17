import React, { useState } from 'react'
import { toast } from 'sonner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { patchCopilotStatus, useCopilotStatus } from '@/lib/monaco-copilot/copilot-status'
import { STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS } from './status-bar-context-menu-policy'

function showSignInFailed(): void {
  toast.error(
    translate(
      'auto.components.status.bar.CopilotStatusSegment.signInFailed',
      'Copilot sign-in failed'
    )
  )
}

/** Copilot ghost-text indicator, shown only when copilot-language-server is
 *  installed; click signs in while no authenticated user is reported. */
export function CopilotStatusSegment({
  iconOnly
}: {
  iconOnly: boolean
}): React.JSX.Element | null {
  const status = useCopilotStatus()
  const [signingIn, setSigningIn] = useState(false)
  if (!status) {
    return null
  }
  const signedIn = status.user !== null && status.kind !== 'Error'
  const dotClass =
    signedIn && status.kind !== 'Inactive'
      ? status.kind === 'Warning'
        ? 'bg-status-warning'
        : 'bg-status-success'
      : 'bg-muted-foreground/40'
  const badge = translate('auto.components.status.bar.CopilotStatusSegment.badge', 'Copilot')
  const tooltip = signedIn
    ? `${translate('auto.components.status.bar.CopilotStatusSegment.signedInAs', 'GitHub Copilot')}: ${status.user}${status.message ? ` — ${status.message}` : ''}`
    : translate(
        'auto.components.status.bar.CopilotStatusSegment.signIn',
        'Click to sign in to GitHub Copilot'
      )

  const handleSignIn = async (): Promise<void> => {
    if (signingIn) {
      return
    }
    setSigningIn(true)
    try {
      const result = await window.api.copilotCompletion.signIn()
      if (result.state === 'pending') {
        toast.info(
          translate(
            'auto.components.status.bar.CopilotStatusSegment.deviceCode',
            'Copilot sign-in code {{code}} copied — paste it in the browser.',
            { code: result.userCode }
          ),
          { duration: 60_000 }
        )
      } else if (result.state === 'alreadySignedIn') {
        patchCopilotStatus({ user: result.user, kind: 'Normal' })
      } else {
        showSignInFailed()
      }
    } catch {
      showSignInFailed()
    } finally {
      setSigningIn(false)
    }
  }

  const content = (
    <>
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full', dotClass, status.busy && 'animate-pulse')}
      />
      {iconOnly ? null : <span className="text-[11px] font-medium">{badge}</span>}
    </>
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {signedIn ? (
          <span
            role="status"
            aria-label={tooltip}
            className="inline-flex select-none items-center gap-1.5 px-1 py-0.5 text-muted-foreground"
          >
            {content}
          </span>
        ) : (
          <button
            type="button"
            {...STATUS_BAR_CONTEXT_MENU_EXEMPT_PROPS}
            aria-label={tooltip}
            onClick={() => void handleSignIn()}
            className="inline-flex cursor-pointer select-none items-center gap-1.5 rounded px-1 py-0.5 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
          >
            {content}
          </button>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
