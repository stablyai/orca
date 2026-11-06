import { beginLinkOpenRequest } from '@/lib/link-open-request'

/** Supersedes earlier opens now, for a click still deciding what to open; true until a later open. */
export function reserveDetectedFilePathOpenTurn(): () => boolean {
  return beginLinkOpenRequest()
}
