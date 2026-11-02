import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { azureDevOpsTeamSelectionKey } from './task-page-azure-devops-backlog-level-selection'

export type AzureDevOpsTeamSelectionSettings = {
  azureDevOpsTeamSelection: Record<string, string> | null
}

export type AzureDevOpsViewSelectionSettings = {
  azureDevOpsViewSelection: Record<string, string> | null
}

/** Mirrors Azure DevOps' own left nav: Work items, Boards, Backlogs. */
export type AzureDevOpsTaskView = 'workItems' | 'backlog' | 'board'

/** Where someone with no stored choice lands, as in Azure DevOps' own hub order. */
export const DEFAULT_AZURE_DEVOPS_TASK_VIEW: AzureDevOpsTaskView = 'workItems'

/** Backlog and board are per level, so the remembered view is scoped to team and level too. */
export function azureDevOpsViewSelectionKey(
  repo: { organization: string | null; project: string },
  teamName: string,
  levelId: string
): string {
  return `${azureDevOpsTeamSelectionKey(repo)}::${teamName}::${levelId}`
}

export function readAzureDevOpsViewSelection(
  settings: AzureDevOpsViewSelectionSettings | null | undefined,
  key: string | null
): AzureDevOpsTaskView | null {
  const stored = key === null ? undefined : settings?.azureDevOpsViewSelection?.[key]
  return stored === 'workItems' || stored === 'backlog' || stored === 'board' ? stored : null
}

/** Remembers the view per level; a failed write toasts and leaves the in-memory pick alone. */
export function persistAzureDevOpsViewSelection(args: {
  key: string
  view: AzureDevOpsTaskView
  settings: AzureDevOpsViewSelectionSettings | null | undefined
  updateSettings: (patch: AzureDevOpsViewSelectionSettings) => Promise<unknown>
}): void {
  void args
    .updateSettings({
      azureDevOpsViewSelection: {
        ...args.settings?.azureDevOpsViewSelection,
        [args.key]: args.view
      }
    })
    .catch((error: unknown) => {
      toast.error(
        translate(
          'auto.components.TaskPage.azureDevOps.board.viewSelectionSaveFailed',
          'Couldn’t save the view selection: {{value0}}',
          { value0: error instanceof Error ? error.message : String(error) }
        )
      )
    })
}

/** Remembers the team per project; a failed write toasts and leaves the in-memory pick alone. */
export function persistAzureDevOpsTeamSelection(args: {
  repo: { organization: string | null; project: string }
  teamName: string
  settings: AzureDevOpsTeamSelectionSettings | null | undefined
  updateSettings: (patch: AzureDevOpsTeamSelectionSettings) => Promise<unknown>
}): void {
  const key = azureDevOpsTeamSelectionKey(args.repo)
  void args
    .updateSettings({
      azureDevOpsTeamSelection: {
        ...args.settings?.azureDevOpsTeamSelection,
        [key]: args.teamName
      }
    })
    .catch((error: unknown) => {
      toast.error(
        translate(
          'auto.components.TaskPage.azureDevOps.teamSelectionSaveFailed',
          'Couldn’t save the team selection: {{value0}}',
          { value0: error instanceof Error ? error.message : String(error) }
        )
      )
    })
}
