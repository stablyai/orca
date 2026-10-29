import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { azureDevOpsTeamSelectionKey } from './task-page-azure-devops-backlog-level-selection'

export type AzureDevOpsTeamSelectionSettings = {
  azureDevOpsTeamSelection: Record<string, string> | null
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
