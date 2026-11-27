import type { ActivityBarPosition } from '../../../../../shared/ui-chrome/ui-chrome-types'
import { preserveStringArrayIdentity } from './ui-slice-hydration-array-identity'

// Any other value would hide the activity bar entirely, since the layout renders only Top or Side.
export function sanitizeActivityBarPosition(position: unknown): ActivityBarPosition {
  return position === 'side' ? 'side' : 'top'
}

export function sanitizeActivityBarArrangement(
  ui: {
    activityBarOrder?: unknown
    activityBarBotOrder?: unknown
    activityBarHidden?: unknown
    activityBarPosition?: unknown
  },
  current: {
    activityBarOrder: string[]
    activityBarBotOrder: string[]
    activityBarHidden: string[]
  }
): {
  activityBarOrder: string[]
  activityBarBotOrder: string[]
  activityBarHidden: string[]
  activityBarPosition: ActivityBarPosition
} {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  return {
    activityBarPosition: sanitizeActivityBarPosition(ui.activityBarPosition),
    activityBarOrder:
      preserveStringArrayIdentity(current.activityBarOrder, strings(ui.activityBarOrder)) ?? [],
    activityBarBotOrder:
      preserveStringArrayIdentity(current.activityBarBotOrder, strings(ui.activityBarBotOrder)) ??
      [],
    activityBarHidden:
      preserveStringArrayIdentity(current.activityBarHidden, strings(ui.activityBarHidden)) ?? []
  }
}
