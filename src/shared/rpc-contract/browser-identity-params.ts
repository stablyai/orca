import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

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
