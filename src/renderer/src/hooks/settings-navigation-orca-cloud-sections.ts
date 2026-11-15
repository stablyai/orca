import {
  getCloudApiKeysSearchEntries,
  getCloudRoutinesSearchEntries
} from '@/components/settings/cloud-api/cloud-api-search'
import {
  getOrcaCloudBillingSearchEntries,
  getOrcaCloudEnvironmentsSearchEntries,
  getOrcaCloudLocalCommandsSearchEntries,
  getOrcaCloudMcpSearchEntries,
  getOrcaCloudSkillsSearchEntries,
  getOrcaCloudSecretsSearchEntries,
  getOrcaCloudTeamAdminSearchEntries,
  getOrcaCloudWorkspacesSearchEntries
} from '@/components/settings/orca-cloud/orca-cloud-settings-search'
import { getCloudAgentSignInsSearchEntries } from '@/components/settings/agent-accounts/agent-accounts-search'
import { translate } from '@/i18n/i18n'
import { canManageActiveTeam } from '@/lib/orca-cloud/orca-cloud-team-role'
import type { Translate } from '@/i18n/use-translate'
import type {
  SettingsNavSection,
  SettingsNavTarget
} from '@/components/settings/navigation/settings-navigation-types'
import type { OrcaProfileAuthStatus } from '../../../shared/orca-profiles'
import {
  BookOpenText,
  Boxes,
  Cloud,
  CreditCard,
  KeySquare,
  LockKeyhole,
  LogIn,
  Plug,
  SquareTerminal,
  Workflow
} from 'lucide-react'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'
import { CLOUD_ROUTINES_UI_ENABLED } from '../../../shared/cloud-api/cloud-routines-ui'

/** One home for everything Orca Cloud; only builds with a control plane show it. */
export function buildOrcaCloudSettingsSections(
  { isWebClient, isOrcaCloudApiAvailable, isOrcaTeamAdmin }: SettingsNavigationBuildOptions,
  t: Translate = translate
): SettingsNavSection[] {
  if (isWebClient || !isOrcaCloudApiAvailable) {
    return []
  }
  const group = 'orca-cloud'
  return [
    {
      id: 'cloud-billing',
      title: t('auto.components.billing.title', 'Plan & billing'),
      description: t(
        'settings.orcaCloud.billing.description',
        'Your Orca Cloud plan, sandbox hours and payment.'
      ),
      icon: CreditCard,
      searchEntries: getOrcaCloudBillingSearchEntries(),
      group
    },
    // Neil: Orca Cloud's Claude and ChatGPT sign-ins are an Orca Cloud setting, not one of this
    // computer's Agent accounts; that page keeps a one-line link here. Right after the account,
    // since setting up an agent once is the first thing a new cloud user does.
    {
      id: 'cloud-agent-sign-ins',
      title: t('settings.cloudAgentSignIns.title', 'Cloud agent sign-ins'),
      description: t(
        'orcaCloudAccounts.helpAccountWide',
        'Set up once. Every cloud workspace uses it, including new, cloned and restarted ones.'
      ),
      icon: LogIn,
      searchEntries: getCloudAgentSignInsSearchEntries(),
      group
    },
    // Team owners and admins only; members and personal accounts never see the entry. Team,
    // billing and admin (single sign-on, audit log) are managed in the web console, reached from
    // the Account page's "Team & admin" row; the desktop has no page for them.
    ...(isOrcaTeamAdmin
      ? [
          {
            id: 'cloud-workspaces',
            title: t('settings.teamWorkspaces.title', 'Cloud workspaces'),
            description: t(
              'settings.teamWorkspaces.description',
              'Every cloud workspace on your team. Only owners and admins can see this page.'
            ),
            icon: Cloud,
            searchEntries: getOrcaCloudWorkspacesSearchEntries(),
            group
          }
        ]
      : []),
    {
      id: 'cloud-secrets',
      title: t('cloudSecrets.title', 'Cloud secrets'),
      description: t(
        'cloudSecrets.descriptionEdge',
        'Orca swaps model API keys and agent sign-ins in at the network edge, so the sandbox never sees them. Other secrets reach cloud workspaces as environment variables that anything in the sandbox can read.'
      ),
      icon: LockKeyhole,
      searchEntries: getOrcaCloudSecretsSearchEntries(),
      group
    },
    {
      id: 'cloud-skills',
      title: t('cloudAgentConfig.title', 'Skills, agents & memory'),
      description: t(
        'settings.orcaCloud.agentConfig.description',
        'Skills, slash commands, subagents, output styles and memory from Claude and Codex on this computer, synced to your cloud workspaces.'
      ),
      icon: BookOpenText,
      searchEntries: getOrcaCloudSkillsSearchEntries(),
      group
    },
    {
      id: 'cloud-environments',
      title: t('settings.orcaCloud.environments.title', 'Cloud environments'),
      description: t(
        'cloudEnvironment.descriptionTeamSaved',
        'Your team’s repos and install script, built once into a saved environment so every cloud workspace starts with dependencies installed.'
      ),
      icon: Boxes,
      searchEntries: getOrcaCloudEnvironmentsSearchEntries(),
      group
    },
    {
      id: 'cloud-mcp',
      title: t('cloudMcpSync.title', 'MCP servers'),
      description: t(
        'settings.orcaCloud.mcp.description',
        'MCP servers from Claude and Codex on this computer, synced to your cloud workspaces.'
      ),
      icon: Plug,
      searchEntries: getOrcaCloudMcpSearchEntries(),
      group
    },
    {
      id: 'cloud-local-commands',
      title: t('localCommands.settings.title', 'Commands on this computer'),
      description: t(
        'localCommands.settings.description',
        'Let agents in your cloud workspaces ask to run a command on this computer. You approve each one.'
      ),
      icon: SquareTerminal,
      searchEntries: getOrcaCloudLocalCommandsSearchEntries(),
      group
    },
    {
      id: 'cloud-api-keys',
      title: t('auto.components.settings.cloudApi.sectionTitle', 'Orca API keys'),
      description: t(
        'auto.components.settings.cloudApi.sectionDescription',
        'For the Orca Cloud API, the orca CLI and MCP clients. Claude or Codex keys go in Cloud secrets.'
      ),
      icon: KeySquare,
      searchEntries: getCloudApiKeysSearchEntries(),
      group
    },
    // Parked until Routines join Automations (one flag, cloud-routines-ui.ts).
    ...cloudRoutinesSection(t, group)
  ]
}

function cloudRoutinesSection(t: Translate, group: string): SettingsNavSection[] {
  if (!CLOUD_ROUTINES_UI_ENABLED) {
    return []
  }
  return [
    {
      id: 'cloud-routines',
      title: t('auto.components.settings.cloudRoutines.sectionTitle', 'Routines'),
      description: t(
        'auto.components.settings.cloudRoutines.sectionDescription',
        'Agents that run in Orca Cloud on a schedule, on GitHub events or from a webhook.'
      ),
      icon: Workflow,
      searchEntries: getCloudRoutinesSearchEntries(),
      group
    }
  ]
}

const ORCA_CLOUD_LEAD_IDS: readonly string[] = ['orca-account']

/** Where Plan & billing lives inside the combined Account + Billing page (scroll anchor). */
export const ACCOUNT_BILLING_PLAN_ANCHOR = 'orca-account-plan-billing'

/** The Account page's "Team & admin" row, which opens the web console (scroll anchor). */
export const ACCOUNT_TEAM_ADMIN_ANCHOR = 'orca-account-team-admin'

/**
 * JA-16: in Orca Cloud builds the Orca account leads the one Orca Cloud group instead of sitting in
 * Set up. Agent accounts stays in AI capabilities for this computer and hosts; Orca Cloud's own
 * sign-ins are the group's Cloud agent sign-ins page (resolveCloudAgentSignInsTarget).
 * Neil: the account and Plan & billing are one page, "Account + Billing" (account on top). Billing's
 * search entries move onto it and land on its Plan & billing part. Searching for members, single
 * sign-on or the audit log lands on its "Team & admin" row, which opens the web console.
 */
export function gatherOrcaCloudSettingsGroup(
  sections: readonly SettingsNavSection[],
  { isWebClient, isOrcaCloudApiAvailable }: SettingsNavigationBuildOptions
): SettingsNavSection[] {
  if (isWebClient || !isOrcaCloudApiAvailable) {
    return [...sections]
  }
  const billing = sections.find((section) => section.id === 'cloud-billing')
  const billingEntries = (billing?.searchEntries ?? []).map((entry) => ({
    ...entry,
    targetSectionId: ACCOUNT_BILLING_PLAN_ANCHOR
  }))
  const teamAdminEntries = getOrcaCloudTeamAdminSearchEntries().map((entry) => ({
    ...entry,
    targetSectionId: ACCOUNT_TEAM_ADMIN_ANCHOR
  }))
  const leadIds = ORCA_CLOUD_LEAD_IDS
  const leads = leadIds
    .map((id) => sections.find((section) => section.id === id))
    .filter((section): section is SettingsNavSection => section !== undefined)
    .map((section) => ({
      ...section,
      group: 'orca-cloud' as const,
      title: translate('settings.accountBilling.title2', 'Account & billing'),
      // Matches the page's own description (settings-setup-workflow-section-renderers).
      description: translate(
        'settings.accountBilling.description',
        'Your Orca account, plan, sandbox hours and payment.'
      ),
      searchEntries: [...section.searchEntries, ...billingEntries, ...teamAdminEntries]
    }))
  const rest = sections.filter(
    (section) => !leadIds.includes(section.id) && section.id !== 'cloud-billing'
  )
  const firstCloud = rest.findIndex((section) => section.group === 'orca-cloud')
  const at = firstCloud === -1 ? rest.length : firstCloud
  return [...rest.slice(0, at), ...leads, ...rest.slice(at)]
}

/**
 * Signed in with billing turned on, as an owner or admin of the active team: the combined page has
 * a billing half. Members don't get it: the console refuses them Plan & billing (n64 P3 #4).
 */
export function hasOrcaBillingAccount(state: {
  orcaProfileAuthStatus: OrcaProfileAuthStatus | null
}): boolean {
  const status = state.orcaProfileAuthStatus
  return (
    status?.state === 'connected' &&
    status.capabilities?.flags.billing === true &&
    canManageActiveTeam(status)
  )
}

/**
 * Neil: the combined page is "Account & billing", and just "Account" when there's no billing to
 * show (signed out, or an account without billing). Only the Orca Cloud group's account is renamed.
 */
export function labelAccountBilling(
  sections: SettingsNavSection[],
  hasBilling: boolean
): SettingsNavSection[] {
  if (hasBilling) {
    return sections
  }
  return sections.map((section) =>
    section.id === 'orca-account' && section.group === 'orca-cloud'
      ? {
          ...section,
          title: translate('settings.accountBilling.accountOnly', 'Account'),
          description: translate(
            'settings.accountBilling.accountOnlyDescription',
            'Your Orca account and what’s included with it.'
          )
        }
      : section
  )
}

/**
 * Old Plan & billing links (pane 'cloud-billing') open the combined page at its Plan & billing part.
 * Only when the combined page exists (desktop with Orca Cloud); otherwise the target is unchanged.
 */
export function resolveAccountBillingTarget<
  T extends { pane: SettingsNavTarget; sectionId?: string }
>(target: T, combined: boolean): T {
  if (!combined || target.pane !== 'cloud-billing') {
    return target
  }
  return {
    ...target,
    pane: 'orca-account',
    sectionId: target.sectionId ?? ACCOUNT_BILLING_PLAN_ANCHOR
  }
}

/** Where Settings › Agent accounts used to hold Orca Cloud's sign-ins (its part's anchors). */
const LEGACY_CLOUD_SIGN_IN_ANCHORS: readonly string[] = ['orca-cloud', 'accounts-orca-cloud']

/**
 * Old links to Agent accounts' Orca Cloud part (pane 'accounts' at 'orca-cloud' or
 * 'accounts-orca-cloud') open Cloud agent sign-ins. Only when that page exists (desktop with Orca
 * Cloud); otherwise the target is unchanged.
 */
export function resolveCloudAgentSignInsTarget<
  T extends { pane: SettingsNavTarget; sectionId?: string }
>(target: T, available: boolean): T {
  if (
    !available ||
    target.pane !== 'accounts' ||
    !target.sectionId ||
    !LEGACY_CLOUD_SIGN_IN_ANCHORS.includes(target.sectionId)
  ) {
    return target
  }
  // The page is the whole target; its legacy anchor doesn't exist there.
  return { ...target, pane: 'cloud-agent-sign-ins', sectionId: undefined }
}

/** True for an Orca Cloud group page (team-level, so host-free): the cloud pages and the Orca account. */
export function isOrcaCloudSettingsSectionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && (id.startsWith('cloud-') || ORCA_CLOUD_LEAD_IDS.includes(id))
}
