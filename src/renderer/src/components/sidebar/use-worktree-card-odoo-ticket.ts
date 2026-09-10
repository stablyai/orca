import { useEffect, useState } from 'react'

import { isWindowVisible } from '@/lib/window-visibility-interval'
import { useAppStore } from '@/store'
import type { OdooTicket } from '../../../../shared/odoo-types'

/**
 * Reads the ticket a worktree links to, for the sidebar card badge.
 *
 * Odoo has no push channel, so the ticket is re-read when the window regains
 * focus rather than on a timer — a poll would cost a round trip per card, and
 * over SSH that lands on the same relay as everything else.
 */
export function useWorktreeCardOdooTicket(args: {
  linkedOdooTicket: number | null | undefined
  linkedOdooInstanceId: string | null | undefined
  enabled: boolean
}): OdooTicket | null {
  const fetchOdooTicket = useAppStore((s) => s.fetchOdooTicket)
  const [ticket, setTicket] = useState<OdooTicket | null>(null)
  const { linkedOdooTicket, linkedOdooInstanceId, enabled } = args

  useEffect(() => {
    if (!linkedOdooTicket || !enabled) {
      setTicket(null)
      return
    }
    let cancelled = false
    const instanceId = linkedOdooInstanceId ?? undefined
    const refreshIfVisible = (): void => {
      if (!isWindowVisible()) {
        return
      }
      void fetchOdooTicket(linkedOdooTicket, instanceId).then((next) => {
        if (!cancelled) {
          setTicket(next)
        }
      })
    }
    refreshIfVisible()
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [linkedOdooTicket, linkedOdooInstanceId, enabled, fetchOdooTicket])

  return ticket
}
