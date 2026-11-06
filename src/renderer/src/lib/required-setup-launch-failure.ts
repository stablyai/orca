import { translate } from '@/i18n/i18n'

export function requiredSetupLaunchFailureText(agent: string): string {
  return translate(
    'auto.components.terminal.pane.AgentLaunchPaneNotice.setupNotCompleted',
    'Setup did not finish successfully, so {{agent}} was not started. Fix or rerun setup, then start {{agent}} in this workspace.',
    { agent }
  )
}
