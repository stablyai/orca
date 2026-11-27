import type { RefinementCtx } from 'zod'
import {
  isKnownTimeZone,
  unknownTimeZoneMessage
} from '../../automations/scheduling/automation-schedule-calendar'

// Only a named zone is judged: a client's default or a stored one an older Orca accepted still saves.
export function refuseUnknownNamedZone(
  value: { timezone?: string; timezoneExplicit?: boolean },
  ctx: RefinementCtx
): void {
  if (value.timezoneExplicit && value.timezone !== undefined && !isKnownTimeZone(value.timezone)) {
    ctx.addIssue({
      code: 'custom',
      path: ['timezone'],
      message: unknownTimeZoneMessage(value.timezone)
    })
  }
}
