import { translate } from '@/i18n/i18n'

// Why: the whole singular/plural sentence must remain translatable; an
// English suffix cannot express other grammars.
export function getLinearWorkspaceLinkSummary(count: number): string {
  return count === 1
    ? translate(
        'auto.components.onboarding.IntegrationsStep.oneWorkspaceLinked',
        '{{count}} workspace linked. Add another workspace or replace a restricted key any time.',
        { count }
      )
    : translate(
        'auto.components.onboarding.IntegrationsStep.manyWorkspacesLinked',
        '{{count}} workspaces linked. Add another workspace or replace a restricted key any time.',
        { count }
      )
}
