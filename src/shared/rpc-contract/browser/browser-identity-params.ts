import { z } from 'zod'
import { OptionalString, requiredString } from '../rpc-param-primitives'

export const ProfileCreate = z
  .object({
    label: requiredString('Missing required --label'),
    // Reject unknown scopes rather than silently coercing to isolated (#1397).
    scope: z.enum(['isolated', 'imported']),
    userAgentMode: z.unknown().optional()
  })
  .superRefine((value, context) => {
    // Reject the retired field so older clients cannot mistake success for per-profile identity support.
    if (value.userAgentMode !== undefined) {
      context.addIssue({
        code: 'custom',
        message: 'browser_profile_user_agent_mode_is_now_app_wide',
        path: ['userAgentMode']
      })
    }
  })
  .transform(({ label, scope }) => ({ label, scope }))

export const BrowserIdentitySet = z.object({
  mode: z.enum(['clean', 'native']),
  // Opt-in overwrite of corrupt or newer-version data; the host backs the old bytes up first.
  reset: z.boolean().optional()
})

export const ProfileDelete = z.object({ profileId: requiredString('Missing required --profile') })

export const ProfileClearGoogleCookies = ProfileDelete.extend({
  executorRuntimeId: z.string().min(1)
})

export const ProfileImportFromBrowser = ProfileDelete.extend({
  supportsPartitionSkippedCookies: z.literal(true).optional(),
  refreshSourceId: z.uuid().optional(),
  browserFamily: OptionalString,
  browserProfile: OptionalString
})
  .superRefine(({ refreshSourceId, browserFamily, browserProfile }, ctx) => {
    if (refreshSourceId && (browserFamily !== undefined || browserProfile !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Choose a browser or refresh a saved Chrome profile'
      })
    } else if (!refreshSourceId && !browserFamily) {
      ctx.addIssue({
        code: 'custom',
        path: ['browserFamily'],
        message: 'Missing required --browser-family'
      })
    }
  })
  .transform(({ refreshSourceId, browserFamily, browserProfile, ...target }) =>
    refreshSourceId
      ? { ...target, refreshSourceId }
      : { ...target, browserFamily: browserFamily!, browserProfile }
  )
