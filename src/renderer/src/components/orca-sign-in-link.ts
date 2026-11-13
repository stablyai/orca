// COPY-LINK-FIRST-CLICK: the link of a browser trip that hasn't started yet (Orca's first "Sign in",
// the setup page's first "Continue in browser"). Copying starts the same flow a click would, without
// the browser, and copies its link: the sign-in's loopback link once main publishes it, or the
// setup session's link when the person is already signed in. A private window on this computer
// then completes it. An unused link ends the way an unanswered click does: the sign-in's own
// timeout closes main's listener (Cancel too), and a setup session expires on the server.
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { requireLink } from './open-external/copy-external-link'

/** How long to wait for the flow to have a link (main's listener up, or the session created). */
export const FIRST_CLICK_LINK_WAIT_MS = 10_000

/**
 * The pending sign-in's link if one is out; otherwise starts the flow (`start`, which may also hand a
 * link back directly through `deliver`) and resolves the first link either way.
 */
export function mintFirstClickLink(
  start: (deliver: (url: string | null) => void) => void,
  waitMs: number = FIRST_CLICK_LINK_WAIT_MS
): Promise<string> {
  const current = useAppStore.getState().orcaProfileSignInProgress?.link ?? null
  if (current) {
    return Promise.resolve(current)
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false
    const finish = (link: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      unsubscribe()
      clearTimeout(timer)
      try {
        resolve(requireLink(link))
      } catch (error) {
        reject(error)
      }
    }
    const unsubscribe = useAppStore.subscribe((state) => {
      const link = state.orcaProfileSignInProgress?.link ?? null
      if (link) {
        finish(link)
      }
    })
    const timer = setTimeout(() => finish(null), waitMs)
    start(finish)
  })
}

/**
 * Where a copied Orca sign-in link works: its callback is this computer's loopback listener, so a
 * private window or another browser profile here, never another machine. Only these links say so.
 */
export function signInLinkHint(): string {
  return translate('openExternal.signInLinkHint', 'Open it in any browser on this computer.')
}
