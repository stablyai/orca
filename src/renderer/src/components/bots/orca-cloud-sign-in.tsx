// The one way a bot surface asks for Orca sign-in before an Orca Cloud feature: a reason, Sign in that
// opens the browser right away, then the action the owner started carries on in the same place.
import React, { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { OrcaSignInWaitNotice } from '@/components/orca-profiles/OrcaSignInProgress'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { useOrcaCloudSignedOut } from './orca-cloud-signed-out'

/** Runs `work` with `busy` set true until it settles, however it ends. */
async function whileBusy(setBusy: (busy: boolean) => void, work: () => Promise<unknown>) {
  setBusy(true)
  try {
    await work()
  } finally {
    setBusy(false)
  }
}

/** Signs in through the browser, then runs `onSignedIn`; busy from the click until both are done. */
function useSignInThen(onSignedIn?: () => unknown): { start: () => void; busy: boolean } {
  const connect = useAppStore((state) => state.connectCurrentOrcaProfile)
  const signingIn = useAppStore((state) => Boolean(state.orcaProfileSignInProgress))
  const [pending, setPending] = useState(false)
  const start = (): void => {
    void whileBusy(setPending, async () => {
      if ((await connect())?.status === 'connected') {
        await onSignedIn?.()
      }
    })
  }
  return { start, busy: pending || signingIn }
}

function SignInButton({
  busy,
  onClick,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Button>, 'onClick' | 'type' | 'children'> & {
  busy: boolean
  onClick: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button {...props} type="button" className={className} disabled={busy} onClick={onClick}>
      {busy ? (
        <>
          <Loader2 className="animate-spin" />
          {t('auto.components.OrcaSignInProgress.signingIn', 'Signing in…')}
        </>
      ) : (
        t('bots.cloudSignIn.signIn', 'Sign in')
      )}
    </Button>
  )
}

/** Sign in, for a dialog that draws its own ask; `onSignedIn` carries on once signed in. */
export function OrcaCloudSignInButton({
  onSignedIn
}: {
  onSignedIn?: () => unknown
}): React.JSX.Element {
  const { start, busy } = useSignInThen(onSignedIn)
  return <SignInButton autoFocus busy={busy} onClick={start} />
}

/** "<what> connects through Orca Cloud. Sign in to Orca to continue." */
export function orcaCloudSignInReason(what: 'slack' | 'github' | 'linear' | 'share'): string {
  switch (what) {
    case 'slack':
      return translate(
        'bots.cloudSignIn.slack',
        'Slack connects through Orca Cloud. Sign in to Orca to continue.'
      )
    case 'github':
      return translate(
        'bots.cloudSignIn.github',
        'GitHub connects through Orca Cloud. Sign in to Orca to continue.'
      )
    case 'linear':
      return translate(
        'bots.cloudSignIn.linear',
        'Linear connects through Orca Cloud. Sign in to Orca to continue.'
      )
    case 'share':
      return translate(
        'bots.cloudSignIn.share',
        'Sharing goes through Orca Cloud. Sign in to Orca to continue.'
      )
  }
}

/** A dialog's whole body while it waits on sign-in: title, one line of why, Cancel then Sign in. */
export function OrcaCloudSignInDialogBody({
  title,
  reason,
  onCancel,
  onSignedIn
}: {
  title: string
  reason: string
  onCancel: () => void
  /** Carries on with what the dialog was opened for; the dialog stays as it is until it settles. */
  onSignedIn?: () => unknown
}): React.JSX.Element {
  const t = useTranslate()
  const { start, busy } = useSignInThen(onSignedIn)
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{reason}</DialogDescription>
      </DialogHeader>
      <OrcaSignInWaitNotice />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {t('bots.cloudSignIn.cancel', 'Cancel')}
        </Button>
        <SignInButton autoFocus busy={busy} onClick={start} />
      </DialogFooter>
    </>
  )
}

const unframed = (body: React.JSX.Element): React.ReactNode => body

/**
 * A setup dialog that needs Orca Cloud: signed out it asks first, and once signed in shows `children`,
 * which start their setup then. `resume` re-reads what the sign-in changed before they show.
 */
export function OrcaCloudSignInGate({
  hostId,
  title,
  reason,
  onCancel,
  resume,
  frame = unframed,
  children
}: {
  hostId?: ExecutionHostId
  title: string
  reason: string
  onCancel: () => void
  resume?: () => Promise<unknown>
  /** Wraps the ask, for a dialog whose `children` bring their own content frame. */
  frame?: (body: React.JSX.Element) => React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const needsSignIn = useOrcaCloudSignedOut(hostId)
  const [resuming, setResuming] = useState(false)
  if (!needsSignIn && !resuming) {
    return <>{children}</>
  }
  return (
    <>
      {frame(
        <OrcaCloudSignInDialogBody
          title={title}
          reason={reason}
          onCancel={onCancel}
          onSignedIn={() => whileBusy(setResuming, async () => resume?.())}
        />
      )}
    </>
  )
}

/** An inline place's ask: one short phrase and Sign in on the surface's own row; `link` reads as a
 *  quiet hint, ending on Sign in. */
export function OrcaCloudSignInLine({
  text,
  onSignedIn,
  link = false,
  className
}: {
  text: string
  onSignedIn?: () => unknown
  link?: boolean
  className?: string
}): React.JSX.Element {
  const { start, busy } = useSignInThen(onSignedIn)
  const waiting = useAppStore((state) => Boolean(state.orcaProfileSignInProgress?.link))
  if (waiting) {
    return <OrcaSignInWaitNotice className={className} />
  }
  return (
    <div
      role="status"
      className={cn('flex items-center gap-2 text-xs text-muted-foreground', className)}
    >
      {link ? (
        <p className="min-w-0 flex-1">
          {text}
          <span aria-hidden> · </span>
          <SignInButton variant="link" size="inlineText" busy={busy} onClick={start} />
        </p>
      ) : (
        <>
          <p className="min-w-0 flex-1">{text}</p>
          <SignInButton variant="outline" size="xs" busy={busy} onClick={start} />
        </>
      )}
    </div>
  )
}

/** How a connector row reads while this computer is signed out of Orca. */
export function signedOutConnectorFace(): {
  description: string
  status: { label: string; tone: 'neutral' }
} {
  return {
    description: translate('bots.cloudSignIn.paused', 'Paused while signed out'),
    status: { label: translate('bots.cloudSignIn.needsSignIn', 'Needs sign-in'), tone: 'neutral' }
  }
}
