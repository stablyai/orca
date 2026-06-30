import { translate } from '@/i18n/i18n'

// Tab model for the Gitea PR workspace sheet. Kept out of the workspace
// component so that file stays focused on data loading and mutations.
export type GiteaPrTab = 'conversation' | 'files' | 'checks'

export function getGiteaPrTabs(
  filesCount: number,
  checksCount: number
): { id: GiteaPrTab; label: string; count?: number }[] {
  return [
    {
      id: 'conversation',
      label: translate('auto.components.GiteaPullRequestWorkspace.f51240a59a', 'Conversation')
    },
    {
      id: 'files',
      label: translate('auto.components.GiteaPullRequestWorkspace.4f4abe43ab', 'Files'),
      count: filesCount
    },
    {
      id: 'checks',
      label: translate('auto.components.GiteaPullRequestWorkspace.95a6c97ba6', 'Checks'),
      count: checksCount
    }
  ]
}
