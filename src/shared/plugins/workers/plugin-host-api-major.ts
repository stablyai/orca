import { z } from 'zod'

/** Host API major this Orca implements. A new major ships beside the old one, never in place. */
export const PLUGIN_HOST_API_MAJOR = 1

/** `pluginApi` manifest value: refused with a reason instead of loading against the wrong API. */
export const pluginApiMajorSchema = z
  .number()
  .refine((major) => major === PLUGIN_HOST_API_MAJOR, {
    error: (issue) =>
      typeof issue.input === 'number' && issue.input > PLUGIN_HOST_API_MAJOR
        ? `targets host API ${issue.input}, but this Orca supports only ${PLUGIN_HOST_API_MAJOR}; update Orca`
        : `must be ${PLUGIN_HOST_API_MAJOR}`
  })
  // Why const for editors only: the refine above gives the runtime its clearer message.
  .meta({ const: PLUGIN_HOST_API_MAJOR })
