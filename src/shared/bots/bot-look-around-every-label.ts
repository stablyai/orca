// A look-around schedule as people read it; the desktop and the phone both say it here.
import type { LookAroundEvery } from './bot-look-around'

type Translate = (key: string, fallback: string, values?: Record<string, unknown>) => string

export function lookAroundEveryLabel(every: LookAroundEvery, t: Translate): string {
  switch (every) {
    case 'every-4h':
      return t('bots.lookAroundEvery.every4h', 'Every 4 hours, 8 AM to 8 PM')
    case 'every-2h':
      return t('bots.lookAroundEvery.every2h', 'Every 2 hours, 8 AM to 8 PM')
    case 'twice-daily':
      return t('bots.lookAroundEvery.twiceDaily', 'Twice a day, 8 AM and 1 PM')
    case 'mornings':
      return t('bots.lookAroundEvery.mornings', 'Each morning at 8 AM')
  }
}
