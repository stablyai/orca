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

/** Parses a card template file; throws with every problem Orca's renderer would refuse. */
export function parsePluginSidebarCardArtifact(raw: string): CardTemplate {
  const template = cardTemplateSchema.parse(JSON.parse(raw))
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
