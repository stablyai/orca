import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { z } from 'zod'
import { OptionsParams } from './structured-agent-session-params'
import {
  AGENT_SESSION_BADGE_ICON_MAX_LENGTH,
  AGENT_SESSION_BADGE_LABEL_MAX_LENGTH
} from '../../agent-session/conversation-naming/agent-session-badge'

// `badge: null` clears it. The host checks the picture's form itself (readAgentSessionBadge).
export const SetBadgeParams = lazyZodSchema(() =>
  OptionsParams.extend({
    badge: z
      .object({
        label: z.string().min(1).max(AGENT_SESSION_BADGE_LABEL_MAX_LENGTH),
        icon: z.string().min(1).max(AGENT_SESSION_BADGE_ICON_MAX_LENGTH)
      })
      .strict()
      .nullable()
  }).strict()
)
