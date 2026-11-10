import { useEffect } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useSecretRequests } from '@/lib/secret-requests/secret-request-store'
import {
  secretRequestAgentName,
  unseenSecretRequests
} from '@/lib/secret-requests/secret-request-routing'
import { secretRequestTitle } from './SecretRequestCard'
import { useSecretRequestSlots } from './secret-request-focus'

// Panes mount a moment after their stream attaches; don't toast for a card that's about to show.
const SETTLE_MS = 2_000
const told = new Set<string>()

/**
 * A request whose workspace isn't on screen would otherwise wait unseen until it expires: say so once,
 * and the card is there when the person opens that workspace.
 */
export function SecretRequestUnseenNotifier(): null {
  const t = useTranslate()
  const requests = useSecretRequests()
  const slots = useSecretRequestSlots()
  useEffect(() => {
    const unseen = unseenSecretRequests(requests, slots).filter(
      (entry) => !told.has(`${entry.environmentId}:${entry.event.requestId}`)
    )
    if (unseen.length === 0) {
      return
    }
    const timer = window.setTimeout(() => {
      for (const entry of unseen) {
        told.add(`${entry.environmentId}:${entry.event.requestId}`)
        toast.info(
          secretRequestTitle(secretRequestAgentName(entry.event.agent), entry.event.name, t),
          {
            description: t(
              'secretRequest.unseen',
              'Open that workspace to answer. The request waits up to 15 minutes.'
            )
          }
        )
      }
    }, SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [requests, slots, t])
  return null
}
