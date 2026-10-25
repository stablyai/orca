import { translate } from '@/i18n/i18n'

/** Bare compact "how long ago" token for the Cmd+J session-age badge, e.g. "3h"/"2d". */
export function formatPaletteSessionAge(
  lastActiveAt: number | null,
  now: number
): string | undefined {
  if (!lastActiveAt) {
    return undefined
  }
  const deltaMs = now - lastActiveAt
  // The accessible label appends “ago”; use a numeric token to avoid “Last active now ago”.
  if (deltaMs < 60_000) {
    return translate('components.cmd-j.paletteSessionAge.underOneMinute', '<1m')
  }
  const minutes = Math.floor(deltaMs / 60_000)
  if (minutes < 60) {
    return translate('components.cmd-j.paletteSessionAge.minutes', '{{value0}}m', {
      value0: minutes
    })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 48) {
    return translate('components.cmd-j.paletteSessionAge.hours', '{{value0}}h', { value0: hours })
  }
  return translate('components.cmd-j.paletteSessionAge.days', '{{value0}}d', {
    value0: Math.floor(hours / 24)
  })
}
