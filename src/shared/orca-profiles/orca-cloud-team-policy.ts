import { z } from 'zod'
import { pluginMarketplaceGitSourceSchema } from '../plugins/catalog/plugin-marketplace'
import { isQualifiedPluginKey } from '../plugins/manifest/plugin-manifest'

export const ORCA_CLOUD_TEAM_SETTINGS = 'team_settings'

export const ORCA_CLOUD_TEAM_POLICY_FLAGS = {
  mobileRelay: 'relay.use',
  bots: 'desktop.bots',
  computerUse: 'desktop.computerUse',
  plugins: 'desktop.plugins',
  officialPlugins: 'plugins.official',
  communityPlugins: 'plugins.community'
} as const

export const orcaCloudTeamPolicySchema = z.object({
  orgId: z.string().min(1),
  internalCatalog: pluginMarketplaceGitSourceSchema.optional(),
  requiredPlugins: z.array(z.string().refine(isQualifiedPluginKey)).max(64).optional(),
  updateChannel: z.enum(['stable', 'rc']).optional(),
  updateDelayDays: z.number().int().min(0).max(90).optional()
})

export type OrcaCloudTeamPolicy = z.infer<typeof orcaCloudTeamPolicySchema>
