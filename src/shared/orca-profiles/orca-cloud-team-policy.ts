import { z } from 'zod'
import { validRange } from 'semver'
import { pluginMarketplaceGitSourceSchema } from '../plugins/catalog/plugin-marketplace'
import { isQualifiedPluginKey } from '../plugins/manifest/plugin-manifest'
import { isValidAppVersion } from '../app-lifecycle/identity/app-version'
import type { OrcaCloudCapabilities } from './orca-cloud-capabilities'
import type { OrcaProfileAuthStatus } from './orca-profiles'

export const ORCA_CLOUD_TEAM_SETTINGS = 'team_settings'

export const ORCA_CLOUD_TEAM_POLICY_FLAGS = {
  mobileRelay: 'relay.use',
  bots: 'desktop.bots',
  computerUse: 'desktop.computerUse',
  plugins: 'desktop.plugins',
  officialPlugins: 'plugins.official',
  communityPlugins: 'plugins.community',
  allowMemberSources: 'plugins.memberSources'
} as const

export type OrcaCloudTeamFeatureFlag =
  (typeof ORCA_CLOUD_TEAM_POLICY_FLAGS)[keyof typeof ORCA_CLOUD_TEAM_POLICY_FLAGS]

export function getGoverningTeamCapabilities(
  capabilities: OrcaCloudCapabilities | undefined
): OrcaCloudCapabilities | undefined {
  return capabilities?.flags[ORCA_CLOUD_TEAM_SETTINGS] === true &&
    capabilities.teamPolicy?.orgIds?.length
    ? capabilities
    : undefined
}

export function isOrcaCloudTeamFeatureBlocked(
  auth: OrcaProfileAuthStatus | null,
  flag: OrcaCloudTeamFeatureFlag
): boolean {
  return getOrcaCloudTeamCapabilities(auth)?.flags[flag] === false
}

export function getOrcaCloudTeamCapabilities(
  auth: OrcaProfileAuthStatus | null
): OrcaCloudCapabilities | undefined {
  return auth?.state === 'connected' && auth.cloud
    ? getGoverningTeamCapabilities(auth.capabilities)
    : undefined
}

const requiredPluginRuleSchema = z.object({
  pluginKey: z.string().refine(isQualifiedPluginKey),
  catalog: z.union([z.enum(['official', 'community']), pluginMarketplaceGitSourceSchema]),
  version: z
    .string()
    .max(128)
    .refine((range) => range.trim().length > 0 && validRange(range) !== null)
})
export type RequiredPluginRule = z.infer<typeof requiredPluginRuleSchema>

export const orcaCloudTeamPolicySchema = z.object({
  orgIds: z.array(z.string().min(1)).min(1),
  reportingOrgIds: z.array(z.string().min(1)).optional(),
  internalCatalogs: z.array(pluginMarketplaceGitSourceSchema).optional(),
  requiredPlugins: z.array(z.string().refine(isQualifiedPluginKey)).optional(),
  requiredPluginRules: z.array(requiredPluginRuleSchema).optional(),
  blockedPlugins: z.array(z.string().refine(isQualifiedPluginKey)).optional(),
  updateChannel: z.enum(['stable', 'rc']).optional(),
  updateDelayDays: z.number().int().min(0).max(90).optional(),
  minimumVersion: z.string().max(64).refine(isValidAppVersion).optional(),
  forceUpdates: z.boolean().optional(),
  forceUpdateDelayDays: z.number().int().min(0).max(30).optional(),
  forceUsesMemberDelay: z.boolean().optional(),
  restartDeadlineHours: z.number().int().min(1).max(168).optional()
})

export type OrcaCloudTeamPolicy = z.infer<typeof orcaCloudTeamPolicySchema>
