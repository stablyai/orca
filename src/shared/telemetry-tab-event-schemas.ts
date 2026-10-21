import { z } from 'zod'

export const TAB_CLOSE_TELEMETRY_SAMPLE_RATE = 0.1

// First request per direction per app session, including empty selections and cancelled save prompts.
// Properties describe that first request; event counts measure session adoption, not click frequency.
export const tabsDirectionalCloseRequestedSchema = z
  .object({
    direction: z.enum(['left', 'right']),
    tab_type: z.enum(['terminal', 'editor', 'agent-session', 'browser', 'simulator']),
    surface: z.enum(['workspace', 'floating']),
    eligible_tab_count: z.number().int().min(0),
    sample_rate: z.literal(TAB_CLOSE_TELEMETRY_SAMPLE_RATE).optional()
  })
  .strict()
