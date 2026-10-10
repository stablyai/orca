import type { ReactNode } from 'react'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { useAppStore } from '@/store'
import { StatusBarUsageChangeNoticeCard } from './StatusBarUsageChangeNoticeCard'
import { useUsagePercentageDisplayChangeNotice } from './UsagePercentageDisplayChangeNotice'

export function StatusBarUsageChangeNotices({
  children,
  hasVisibleUsageMeters
}: {
  children: ReactNode
  hasVisibleUsageMeters: boolean
}): React.JSX.Element {
  const ready = useAppStore((s) => s.persistedUIReady)
  const dismissed = useAppStore((s) => s.statusBarCompactChangeNoticeDismissed)
  const dismiss = useAppStore((s) => s.dismissStatusBarCompactChangeNotice)
  const mode = useAppStore((s) => s.statusBarUsageMode)
  const visible = useAppStore((s) => s.statusBarVisible)
  const modal = useAppStore((s) => s.activeModal)

  const percentageNotice = useUsagePercentageDisplayChangeNotice(hasVisibleUsageMeters)
  const notice =
    !dismissed && mode === 'compact'
      ? {
          noticeKey: 'compact',
          eligible: ready && visible && hasVisibleUsageMeters && modal === 'none',
          dismiss,
          title: translate(
            'auto.components.status.bar.StatusBarUsageChangeNotices.compactTitle',
            'Usage display is now compact'
          ),
          description: (
            <Trans
              i18n={i18n}
              defaults={translate(
                'auto.components.status.bar.StatusBarUsageChangeNotices.compactBody',
                'One headline metric per provider. Choose <detailed>Detailed</detailed> in the Usage menu to show more limits.'
              )}
              components={{ detailed: <Badge variant="dot" /> }}
            />
          )
        }
      : percentageNotice

  // Keep the usage trigger and open menu mounted when the notice changes.
  return <StatusBarUsageChangeNoticeCard {...notice}>{children}</StatusBarUsageChangeNoticeCard>
}
