import { z } from 'zod'
import {
  CARD_TEMPLATE_LIMITS,
  cardTemplateSchema,
  type CardTemplate
} from '../../workspace-cards/card-template-schema'
import { cardTemplateIssues } from '../../workspace-cards/card-template-validation'
import { pluginContentIdSchema } from './plugin-theme-artifact'

export const PLUGIN_SIDEBAR_CARD_MAX_BYTES = CARD_TEMPLATE_LIMITS.maxBytes

const pluginSidebarCardRegistrationSchema = z.object({
  id: pluginContentIdSchema,
  pluginKey: z.string(),
  pluginName: z.string(),
  label: z.string(),
  description: z.string().optional(),
  revision: z.string(),
  template: cardTemplateSchema
})

export type PluginSidebarCardRegistration = Omit<
  z.infer<typeof pluginSidebarCardRegistrationSchema>,
  'template'
> & { template: CardTemplate }

// Why before zod: its recursive parse overflows the stack on very deep input instead of naming the cap.
function assertNestingWithinCap(value: unknown): void {
  const stack: [unknown, number][] = [[value, 0]]
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!
    if (depth > CARD_TEMPLATE_LIMITS.maxDepth * 4) {
      throw new Error(`nested deeper than ${CARD_TEMPLATE_LIMITS.maxDepth}`)
    }
    if (typeof node === 'object' && node !== null) {
      for (const child of Object.values(node)) {
        stack.push([child, depth + 1])
      }
    }
  }
}

/** Parses a card template file; throws with the first problem Orca's renderer would refuse. */
export function parsePluginSidebarCardArtifact(raw: string): CardTemplate {
  const json: unknown = JSON.parse(raw)
  assertNestingWithinCap(json)
  const template = cardTemplateSchema.parse(json)
  const issues = cardTemplateIssues(template)
  if (issues.length > 0) {
    throw new Error(issues.slice(0, 5).join('; '))
  }
  return template
}

export function isPluginSidebarCardRegistration(
  value: unknown
): value is PluginSidebarCardRegistration {
  return pluginSidebarCardRegistrationSchema.safeParse(value).success
}
