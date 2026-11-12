import { redactKagiSessionToken } from '../browser-url'
import { ORCA_BROWSER_BLANK_URL } from './browser-blank-page'

export function getBrowserDisplayTitle(title: string | null | undefined, url: string): string {
  if (
    url === 'about:blank' ||
    url === ORCA_BROWSER_BLANK_URL ||
    title === 'about:blank' ||
    title === ORCA_BROWSER_BLANK_URL
  ) {
    return 'New Tab'
  }
  return title || redactKagiSessionToken(url) || 'New Tab'
}
