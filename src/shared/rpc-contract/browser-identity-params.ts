import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

// Why these two sit together: both carry the move of browser identity from a per-profile setting
// to one app-wide choice -- one refuses the retired field, the other sets its replacement.

export const ProfileCreate = z
  .object({
    label: requiredString('Missing required --label'),
    // Strict enum so unknown scope values surface validation errors instead of being
    // silently coerced to 'isolated' (pr-bug-scan finding from #1397).
    scope: z.enum(['isolated', 'imported']),
    userAgentMode: z.unknown().optional()
  })
  .superRefine((value, context) => {
    // Why reject rather than drop: accepting it would report success for a request whose meaning
    // changed, leaving an older client believing it had set a per-profile identity.
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
