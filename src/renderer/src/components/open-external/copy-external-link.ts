// "Copy link" for buttons that open a page in the user's browser (Neil's rule: every such button
// offers it, so a sign-in or billing link can go to an incognito window or another browser profile).
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/**
 * The exact URL the button opens: known up front, or minted on demand the same way the button mints
 * it (a Stripe session, a one-time setup link). A lazy source resolves to null when it already told
 * the person why there is no link (signed out, no billing account); nothing more is said then.
 */
export type ExternalLinkSource = string | (() => Promise<string | null>)

/** For a lazy source with nothing else to say: no link yet reads as "Couldn't copy the link". */
export function requireLink(url: string | null): string {
  if (!url) {
    throw new Error('No link to copy yet')
  }
  return url
}

export type CopyExternalLinkResult = 'copied' | 'no-link' | 'failed'

export async function copyExternalLink(
  source: ExternalLinkSource,
  /** A limit worth saying once it's copied (only loopback sign-in links: "on this computer"). */
  hint?: string
): Promise<CopyExternalLinkResult> {
  let url: string | null
  try {
    url = typeof source === 'string' ? source : await source()
  } catch (error) {
    console.warn('Could not get the link to copy:', error)
    toast.error(translate('openExternal.copyLinkFailed', 'Couldn’t copy the link.'))
    return 'failed'
  }
  if (!url) {
    return 'no-link'
  }
  try {
    // Through main, never navigator.clipboard: that one fails in Electron once the click's user
    // activation is gone, which it is after the await above.
    await window.api.ui.writeClipboardText(url)
  } catch (error) {
    console.warn('Could not copy the link:', error)
    toast.error(translate('openExternal.copyLinkFailed', 'Couldn’t copy the link.'))
    return 'failed'
  }
  const copied = translate('openExternal.linkCopied', 'Link copied')
  if (hint) {
    toast.success(copied, { description: hint })
  } else {
    toast.success(copied)
  }
  return 'copied'
}
