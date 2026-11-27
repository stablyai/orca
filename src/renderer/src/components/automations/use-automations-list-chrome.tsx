import { RailPageNav } from '@/components/rail-page/RailPageToolbar'
import { useTranslate } from '@/i18n/use-translate'
import type { AutomationsPageController } from './use-automations-page-controller'

export function useAutomationsListChrome(controller: AutomationsPageController) {
  const t = useTranslate()
  const { local, list, navigation } = controller
  const { hostCatalog } = list
  const { isLoading } = local
  const label = t('auto.components.automations.AutomationsPage.77c2778945', 'Automations')
  const allHostsLoaded =
    hostCatalog.resolution.effective.kind === 'all' &&
    !local.listFilter.hostStableKeys?.length &&
    hostCatalog.loadCounts.failedHostCount === 0 &&
    hostCatalog.entries.every(
      (entry) =>
        entry.catalogState === 'removed' ||
        (entry.catalogState === 'authoritative' && entry.authorityHealth === 'fresh')
    )
  const count =
    !isLoading &&
    allHostsLoaded &&
    !list.scopedExternal.loading &&
    list.scopedExternal.failures.length === 0 &&
    !list.externalManagersUncheckedNotice
      ? // Every listed automation, before search and filters (waits are never listed).
        list.searchCounts.hostRowCount
      : null
  const tabs = (current: 'automations' | 'runs'): React.ReactNode => (
    <RailPageNav
      label={label}
      items={[
        {
          key: 'automations',
          label,
          current: current === 'automations',
          onSelect: navigation.showList
        },
        {
          key: 'runs',
          label: t('auto.components.automations.AutomationListToolbar.runs', 'Runs'),
          current: current === 'runs',
          itemProps: { 'data-contextual-tour-target': 'automations-runs' },
          onSelect: () => {
            hostCatalog.selectHost({ kind: 'all' })
            navigation.showRuns()
          }
        }
      ]}
    />
  )
  return { label, count, tabs }
}
