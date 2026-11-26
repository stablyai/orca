import type {
  HttpLinkActionChoice,
  HttpLinkActionDestinations,
  HttpLinkDestination,
  LinkActionContext
} from '@/lib/browser/navigation/http-link-destinations'
import type { HttpLinkAdmission } from '@/lib/browser/navigation/http-link-routing'
import {
  admitLinkPreferenceOperation,
  beginLinkPreferenceOperation,
  writeLinkPreference
} from './link-preference-operation'
import { storeLinkPreferenceWriter } from './link-preference-store-writer'
import { rememberedLinkFields, usesHttpLinkMode, type HttpLinkMode } from './http-link-mode'

/** §3.2: plain click in Ask, both browsers offered, a qualified click host, desktop only. */
export function canRememberLinkChoice(args: {
  plainClick: boolean
  mode: HttpLinkMode
  destinations: HttpLinkActionDestinations
  actionContext: LinkActionContext
}): boolean {
  return (
    usesHttpLinkMode() &&
    args.plainClick &&
    args.mode === 'ask' &&
    args.destinations.alternate !== undefined &&
    args.actionContext.clickHostId !== null
  )
}

/** Starts the Remember operation at selection; it writes only if the open is admitted while still newest. */
export function rememberOnAdmission(
  destination: HttpLinkDestination,
  choice: HttpLinkActionChoice | undefined
): ((outcome: HttpLinkAdmission) => void) | undefined {
  if (!choice?.remember) {
    return undefined
  }
  const op = beginLinkPreferenceOperation('remember', rememberedLinkFields(destination))
  return (outcome) => {
    if (admitLinkPreferenceOperation(op, outcome)) {
      // Never awaited: saving is not part of admitting the open.
      void writeLinkPreference(op, storeLinkPreferenceWriter)
    }
  }
}
