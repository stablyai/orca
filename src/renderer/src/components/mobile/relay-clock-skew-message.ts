import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function relayClockSkewMessage(clockOffsetMs: number, t: Translate = translate): string {
  return t(
    'auto.components.mobile.relayClockSkewMessage.message',
    "Your computer's clock is off by about {{seconds}} seconds. Turn on automatic time, then retry.",
    { seconds: Math.round(Math.abs(clockOffsetMs) / 1000) }
  )
}
