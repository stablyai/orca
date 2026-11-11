import type { Translate } from '@/i18n/use-translate'

/** One sentence for a poke that didn't go out (control-plane error + reason). */
export function pokeRefusalCopy(
  result: { error: string; reason?: string },
  name: string,
  t: Translate
): string {
  switch (result.reason ?? '') {
    case 'pokes_off':
      return t(
        'auto.components.teammates.pokesOffYouActivity',
        'Pokes are off. Turn on Pokes and activity in Settings → Experimental.'
      )
    case 'teammate_pokes_off':
      return t('auto.components.teammates.pokesOffThem', '{{name}} hasn’t turned on Pokes yet.', {
        name
      })
    case 'poke_cooldown':
      return t(
        'auto.components.teammates.pokeCooldown',
        'You just poked {{name}}. Try again in a minute.',
        { name }
      )
    case 'poke_rate':
      return t('auto.components.teammates.pokeRate', 'That’s a lot of pokes. Try again later.')
    default:
      return result.error === 'unavailable' || result.error === 'timeout'
        ? t(
            'auto.components.teammates.pokeOffline',
            'Can’t reach Orca Cloud right now. Check your connection.'
          )
        : t('auto.components.teammates.pokeFailed', 'Couldn’t send the poke. Try again.')
  }
}

/** The account a Pokes opt-in belongs to (user in a team). */
export function pokesAccountKey(
  userId: string | null | undefined,
  orgId: string | null | undefined
): string | null {
  return userId && orgId ? `${userId}:${orgId}` : null
}
