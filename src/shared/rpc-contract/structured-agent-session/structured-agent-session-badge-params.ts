import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { z } from 'zod'
import { OptionsParams } from './structured-agent-session-params'
import { AGENT_SESSION_BADGE_ICON_MAX_LENGTH } from '../../agent-session/conversation-naming/agent-session-badge'

// `badge: null` clears it. The host normalizes the label and checks the picture itself
// (readAgentSessionBadge), as rename leaves trimming to the host.
export const SetBadgeParams = lazyZodSchema(() =>
  OptionsParams.extend({
    badge: z
      .object({
        label: z.string().min(1).max(4096),
        icon: z.string().min(1).max(AGENT_SESSION_BADGE_ICON_MAX_LENGTH)
      })
      .strict()
      .nullable()
  }).strict()
)
