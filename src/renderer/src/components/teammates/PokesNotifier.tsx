// In-app delivery for Pokes: while you're on a team with Pokes on and Orca is in front, check for
// new pokes every 30 s (and when Orca comes back to the front), show each one once as a toast with
// "Poke back", then mark it seen. Nothing runs when Pokes are off.
import { useEffect } from 'react'
import { toast } from 'sonner'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { Poke } from '../../../../shared/cloud-workspaces/team-presence-wire'
import { loadOrgRoster } from '../billing/team/use-org-roster'
import { pokeRefusalCopy, pokesAccountKey } from './poke-copy'
import { readPokes, usePokesState } from './pokes-store'
import { openTeammateProfile } from './teammate-profile-store'

export const POKE_POLL_MS = 30_000

export function PokesNotifier(): null {
  const t = useTranslate()
  const cloud = useAppStore((state) => state.orcaProfileAuthStatus?.cloud)
  const accountKey = pokesAccountKey(cloud?.userId, cloud?.activeOrgId)
  const orgId = cloud?.activeOrgId ?? null
  const { enabled, accountKey: stateKey } = usePokesState()
  const live = enabled === true && stateKey === accountKey

  useEffect(() => {
    if (!accountKey) {
      return
    }
    let stopped = false
    const shown = new Set<string>()
    const show = (pokes: Poke[]): void => {
      const fresh = pokes.filter((p) => !shown.has(p.id)).toReversed()
      if (fresh.length === 0 || stopped) {
        return
      }
      for (const poke of fresh) {
        shown.add(poke.id)
        const name = poke.fromName ?? t('auto.components.teammates.someone', 'A teammate')
        toast(t('auto.components.teammates.pokedYou', '{{name}} poked you', { name }), {
          id: `poke-${poke.id}`,
          duration: 10_000,
          action: {
            label: t('auto.components.teammates.pokeBack', 'Poke back'),
            onClick: () => {
              void window.api.cloudWorkspaces.poke(poke.fromUserId).then((result) => {
                if (result.ok) {
                  toast.success(t('auto.components.teammates.poked', 'Poked {{name}}', { name }))
                } else {
                  toast.error(pokeRefusalCopy(result, name, t))
                }
              })
            }
          },
          cancel: {
            label: t('auto.components.teammates.viewProfile', 'View profile'),
            onClick: () => openTeammateProfile(poke.fromUserId)
          }
        })
      }
      // Names on toasts come from the roster when it has them; warm it for the profile too.
      if (orgId) {
        void loadOrgRoster(orgId)
      }
      void window.api.cloudWorkspaces.markPokesSeen(fresh.map((p) => p.id)).catch(() => undefined)
    }
    const tick = (): void => {
      void readPokes(accountKey).then(show)
    }
    // First read learns the opt-in; it only keeps polling while Pokes are on, and only while
    // Orca is visible (catching up as soon as it comes back).
    if (!live) {
      tick()
      return () => {
        stopped = true
      }
    }
    const stop = installWindowVisibilityInterval({
      run: tick,
      intervalMs: POKE_POLL_MS,
      slowWhileUnfocused: true
    })
    return () => {
      stopped = true
      stop()
    }
  }, [accountKey, live, orgId, t])

  return null
}
