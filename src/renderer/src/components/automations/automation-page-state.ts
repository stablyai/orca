import type {
  ExternalAutomationJob,
  ExternalAutomationManager,
  ExternalAutomationRun
} from '../../../../shared/automations-types'

/** Detail-pane tab shared by the page, its list panel, and the detail pane. */
export type AutomationPaneTab = 'overview' | 'runs'

/** Top-level surface within Automations. */
export type AutomationsPageView = 'automations' | 'runs' | 'run'

export type AutomationRunPageOrigin = 'runs' | 'automation'

/** External run opened as a full page inside the detail pane. */
export type SelectedExternalRunPage = {
  manager: ExternalAutomationManager
  job: ExternalAutomationJob
  run: ExternalAutomationRun
}
