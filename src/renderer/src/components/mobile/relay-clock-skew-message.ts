import { translate } from '@/i18n/i18n'

export function relayClockSkewMessage(clockOffsetMs: number): string {
  return translate(
    'auto.components.mobile.relayClockSkewMessage.message',
    "Your computer's clock is off by about {{seconds}} seconds. Turn on automatic time, then retry.",
    { seconds: Math.round(Math.abs(clockOffsetMs) / 1000) }
  )
}
