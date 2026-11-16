// "Sign-ins by host" words (§7 annotation 4). The Orca Cloud cells reuse the panel and build-sheet wording.
import type { Translate } from '@/i18n/use-translate'
import { formatDate } from '../orca-cloud-account-row-shell'
import { keyOptionLabel, productName } from '../orca-cloud-accounts-copy'
import type { OverviewCell } from './agent-accounts-overview-model'

export type OverviewCellTone = 'plain' | 'muted' | 'warning'

export function overviewCellText(
  cell: OverviewCell,
  t: Translate
): { text: string; tone: OverviewCellTone } {
  switch (cell.kind) {
    case 'signedIn':
      return { text: t('agentAccountsOverview.cell.signedIn', 'Signed in'), tone: 'plain' }
    case 'signedInChecked':
      return {
        text: t('agentAccountsOverview.cell.signedInChecked', 'Signed in · checked {{date}}', {
          date: formatDate(cell.checkedAt)
        }),
        tone: 'muted'
      }
    case 'signedOut':
      return { text: t('agentAccountsOverview.cell.signedOut', 'Signed out'), tone: 'warning' }
    case 'expired':
      return {
        text: t('agentAccountsOverview.cell.expired', 'Sign-in expired'),
        tone: 'warning'
      }
    case 'apiKey':
      return { text: t('agentAccountsOverview.cell.apiKey', 'API key'), tone: 'plain' }
    case 'apiKeyOverrides':
      return {
        text: t('agentAccountsOverview.cell.apiKeyOverrides', 'API key overrides sign-in'),
        tone: 'warning'
      }
    case 'notInstalled':
      return { text: t('agentAccountsOverview.cell.notInstalled', 'Not installed'), tone: 'muted' }
    case 'notConnected':
      return { text: t('agentAccountsOverview.cell.notConnected', 'Not connected'), tone: 'muted' }
    case 'checking':
      return { text: t('agentAccountsOverview.cell.checking', 'Checking…'), tone: 'muted' }
    case 'couldntCheck':
      return {
        text: t('agentAccountsOverview.cell.couldntCheck', 'Couldn’t check'),
        tone: 'warning'
      }
    case 'cloudAccount':
      return {
        text: t('agentAccountsOverview.cell.cloudAccount', 'Your Orca account'),
        tone: 'plain'
      }
    case 'cloudKey':
      return {
        text: cell.member
          ? t('agentAccountsOverview.cell.cloudKeyMember', '{{key}} · set by your team', {
              key: keyOptionLabel(cell.keyKind, t)
            })
          : keyOptionLabel(cell.keyKind, t),
        tone: 'plain'
      }
    case 'cloudNotSetUp':
      return { text: t('agentAccountsOverview.cell.cloudNotSetUp', 'Not set up'), tone: 'muted' }
    case 'cloudExpired':
      return {
        text: t('agentAccountsOverview.cell.expired', 'Sign-in expired'),
        tone: 'warning'
      }
    case 'cloudPaused':
      return {
        text: t('agentAccountsOverview.cell.cloudPaused', 'Each workspace signs in (temporarily)'),
        tone: 'muted'
      }
    case 'cloudNotOffered':
      return {
        text: t('vmBuildAgents.notOffered', 'Signs in for each cloud workspace for now'),
        tone: 'muted'
      }
    case 'cloudInWorkspace':
      return {
        text: t('orcaCloudAccounts.inWorkspace', 'Signs in inside each workspace'),
        tone: 'muted'
      }
  }
}

/** Why "API key overrides sign-in" matters: who pays, and how to use the sign-in. */
export function apiKeyOverridesDetail(agent: 'claude' | 'codex', t: Translate): string {
  return t(
    'agentHostPanel.host.apiKeyOverridesDetail',
    'Usage is billed to the API key, not your {{product}} account. Remove the key for this host to use the sign-in.',
    { product: productName(agent, t) }
  )
}
