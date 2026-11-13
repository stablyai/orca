// A setup step's browser hop ("Continue in browser"). With a link source, its chevron offers "Copy
// link": the same page, minted the same way, for another browser or profile.
import type React from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import { OpenExternalSplitButton } from '@/components/open-external/OpenExternalSplitButton'
import type { ExternalLinkSource } from '@/components/open-external/copy-external-link'
import { signInLinkHint } from '../orca-sign-in-link'
import type { CloudSetupFlow } from './use-cloud-setup-flow'

export function CloudSetupBrowserButton({
  label,
  busy,
  onClick,
  link,
  copyHint
}: {
  label: string
  busy: boolean
  onClick: () => void
  link?: ExternalLinkSource | null
  /** A loopback sign-in link's "on this computer" line (signed out, the trip starts with sign-in). */
  copyHint?: string
}): React.JSX.Element {
  return (
    <OpenExternalSplitButton
      link={link ?? null}
      onClick={onClick}
      disabled={busy}
      {...(copyHint ? { copyHint } : {})}
    >
      {busy ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : null}
      {label}
      <ExternalLink aria-hidden />
    </OpenExternalSplitButton>
  )
}

/**
 * A step's browser button on the setup page. Signed out, the first "Continue in browser" copies the
 * sign-in's loopback link, which only completes on this computer, so it says so.
 */
export function CloudSetupFlowBrowserButton({
  flow,
  label,
  onClick,
  link
}: {
  flow: Pick<CloudSetupFlow, 'busy' | 'action' | 'continueLink'>
  label: string
  onClick: () => void
  link?: ExternalLinkSource | null
}): React.JSX.Element {
  const signIn = flow.action === 'sign-in' && link === flow.continueLink
  return (
    <CloudSetupBrowserButton
      label={label}
      busy={flow.busy}
      onClick={onClick}
      link={link ?? null}
      {...(signIn ? { copyHint: signInLinkHint() } : {})}
    />
  )
}
