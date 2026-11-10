import type { ComponentProps, ReactNode } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { shouldShowUsagePercentageDisplayChangeNotice } from '../../../../shared/usage-percentage-display-change-notice'
import { USAGE_PERCENTAGE_DISPLAY_SETTING_ID } from '../settings/appearance/appearance-usage-percentage-search'
import { StatusBarUsageChangeNoticeCard } from './StatusBarUsageChangeNoticeCard'

function openUsagePercentageSettings(): void {
  const store = useAppStore.getState()
  // Clear search and deep-link to the stable Appearance row so Window expands without stale filtering.
  store.openSettingsPage()
  store.openSettingsTarget({
    pane: 'appearance',
    repoId: null,
    sectionId: USAGE_PERCENTAGE_DISPLAY_SETTING_ID
  })
}

export function useUsagePercentageDisplayChangeNotice(
  hasVisibleUsageMeters: boolean
): Omit<ComponentProps<typeof StatusBarUsageChangeNoticeCard>, 'children'> {
  const t = useTranslate()
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const dismissed = useAppStore((s) => s.usagePercentageDisplayChangeNoticeDismissed)
  const dismiss = useAppStore((s) => s.dismissUsagePercentageDisplayChangeNotice)
  const statusBarVisible = useAppStore((s) => s.statusBarVisible)
  const activeModal = useAppStore((s) => s.activeModal)
  const eligible = shouldShowUsagePercentageDisplayChangeNotice({
    persistedUIReady,
    usagePercentageDisplayChangeNoticeDismissed: dismissed,
    statusBarVisible,
    hasVisibleUsageMeters,
    activeModal
  })

  return {
    noticeKey: 'percentage',
    eligible,
    dismiss,
    title: t(
      'auto.components.status.bar.UsagePercentageDisplayChangeNotice.title',
      'Usage now shows % used'
    ),
    description: t(
      'auto.components.status.bar.UsagePercentageDisplayChangeNotice.body',
      'Prefer remaining? Change it in Settings.'
    ),
    action: {
      label: t(
        'auto.components.status.bar.UsagePercentageDisplayChangeNotice.openSettings',
        'Open Settings'
      ),
      onClick: () => {
        dismiss()
        openUsagePercentageSettings()
      }
    }
  }
}

export function UsagePercentageDisplayChangeNotice({
  children,
  hasVisibleUsageMeters
}: {
  children: ReactNode
  hasVisibleUsageMeters: boolean
}): React.JSX.Element {
  const notice = useUsagePercentageDisplayChangeNotice(hasVisibleUsageMeters)
  return <StatusBarUsageChangeNoticeCard {...notice}>{children}</StatusBarUsageChangeNoticeCard>
}
