import type { GlobalSettings } from './global-settings-types'
import { TASK_PROVIDERS } from '../work-items/task-providers'
import { DEFAULT_AZURE_DEVOPS_BOARDS_SETTINGS } from '../azure-devops/boards-settings-types'

type TaskSelectionSettings = Pick<
  GlobalSettings,
  | 'defaultTaskViewPreset'
  | 'defaultTaskSource'
  | 'visibleTaskProviders'
  | 'visibleTaskProvidersDefaultedForJira'
  | 'defaultRepoSelection'
  | 'defaultLinearTeamSelection'
  | keyof typeof DEFAULT_AZURE_DEVOPS_BOARDS_SETTINGS
>

/** Which task provider the Tasks page opens on, and what each provider's picker remembers. */
export const DEFAULT_TASK_SELECTION_SETTINGS: TaskSelectionSettings = {
  defaultTaskViewPreset: 'all',
  defaultTaskSource: 'github',
  visibleTaskProviders: [...TASK_PROVIDERS],
  visibleTaskProvidersDefaultedForJira: true,
  defaultRepoSelection: null,
  defaultLinearTeamSelection: null,
  ...DEFAULT_AZURE_DEVOPS_BOARDS_SETTINGS
}
