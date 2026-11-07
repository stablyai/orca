import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getProjectGroupingIndexFromState } from '@/store/project-host-setup-selector'
import { getExecutionHostLabel, parseExecutionHostId } from '../../../../shared/execution-host'
import type { LocalizedContextualTourStepCopy } from './contextual-tour-step-copy'

/** Names the captured project and its host, read when the tip renders. */
export function getProjectGroupingUpgradeTipCopy(): LocalizedContextualTourStepCopy {
  const state = useAppStore.getState()
  const audience = state.projectGroupingUpgradeTipAudience
  const group =
    audience?.membership === 'eligible'
      ? getProjectGroupingIndexFromState(state).groupByKey.get(`project:${audience.projectId}`)
      : undefined
  const parsed = audience?.membership === 'eligible' ? parseExecutionHostId(audience.hostId) : null
  const host = parsed
    ? (state.settings?.hostSettingOverrides?.[parsed.id]?.displayLabel ??
      (parsed.kind === 'ssh'
        ? state.sshTargetLabels.get(parsed.targetId)
        : parsed.kind === 'runtime'
          ? state.runtimeEnvironments.find((entry) => entry.id === parsed.environmentId)?.name
          : null) ??
      getExecutionHostLabel(parsed.id))
    : ''
  return {
    title: translate('settings.projectGrouping.upgrade.title', '{{project}} is now one project', {
      project: group?.label ?? ''
    }),
    body: translate(
      'settings.projectGrouping.upgrade.body',
      'Your {{count}} checkouts of {{project}} on {{host}} used to show as separate projects. Orca now groups every checkout of a repository into one project, here and in Session History.',
      {
        count: audience?.membership === 'eligible' ? audience.checkoutCount : 0,
        project: group?.label ?? '',
        host
      }
    ),
    primaryActionLabel: translate('settings.projectGrouping.upgrade.gotIt', 'Got it')
  }
}
