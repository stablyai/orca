import { z } from 'zod'

export const MOBILE_WEB_TERMINAL_MAX_OSC_LINKS = 4_096
export const MOBILE_WEB_TERMINAL_MAX_OSC_LINK_ROW = 50_000
export const MOBILE_WEB_TERMINAL_MAX_OSC_LINK_URI_LENGTH = 4_096
export const MOBILE_WEB_TERMINAL_MAX_OSC_LINK_URI_CHARACTERS = 256 * 1024

const TerminalOscLinkRangeSchema = z
  .object({
    row: z.number().int().nonnegative().max(MOBILE_WEB_TERMINAL_MAX_OSC_LINK_ROW),
    startCol: z.number().int().nonnegative().max(1_000),
    endCol: z.number().int().positive().max(1_000),
    uri: z.string().min(1).max(MOBILE_WEB_TERMINAL_MAX_OSC_LINK_URI_LENGTH)
  })
  .strict()
  .refine((range) => range.endCol > range.startCol, 'OSC link range must advance')

export const MobileWebTerminalOscLinksSchema = z
  .array(TerminalOscLinkRangeSchema)
  .max(MOBILE_WEB_TERMINAL_MAX_OSC_LINKS)
  .superRefine((links, context) => {
    const uriCharacters = links.reduce((total, link) => total + link.uri.length, 0)
    if (uriCharacters > MOBILE_WEB_TERMINAL_MAX_OSC_LINK_URI_CHARACTERS) {
      context.addIssue({ code: 'custom', message: 'OSC link URIs exceed aggregate limit' })
    }
  })

export type MobileWebTerminalOscLinkRange = z.infer<typeof TerminalOscLinkRangeSchema>
