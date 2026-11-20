import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { TRAILING_ACTIONS_CLASS_NAMES } from '@/components/ui/sonner'
import { getEffectiveBrowserMemorySaverHours } from '../../../../shared/browser/guest-lifecycle/browser-memory-saver'
import { withPerfNoticeOff } from '../../../../shared/perf-notices/perf-notice-settings'
import { recordPerfNoticeShown, snoozePerfNotice } from './perf-notice-ledger'

export type PerfNotice = { id: 'hidden-browser-tabs' }

type Copy = {
  title: string
  description: string
  action?: { label: string; onClick: () => void }
}

/** The hours Memory Saver will use once on, so the copy matches what the button does. */
export function memorySaverHours(): number {
  return getEffectiveBrowserMemorySaverHours(
    useAppStore.getState().settings?.browserMemorySaverHours
  )
}

function copyFor(notice: PerfNotice): Copy {
  switch (notice.id) {
    case 'hidden-browser-tabs':
      return {
        title: translate('perfNotices.hiddenTabs.title', 'Save memory from inactive tabs'),
        description: translate(
          'perfNotices.hiddenTabs.description',
          "Turn on Orca's browser memory saver to free up memory from inactive tabs."
        ),
        action: {
          label: translate('perfNotices.hiddenTabs.turnOnMemorySaver', 'Turn on Memory Saver'),
          onClick: () =>
            void useAppStore
              .getState()
              .updateSettings({ browserGuestWorktreeRetentionBudget: true })
        }
      }
  }
}

function perfNoticeToastId(id: PerfNotice['id']): string {
  return `perf-notice-${id}`
}

export function showPerfNotice(notice: PerfNotice, now: number): void {
  const id = notice.id
  recordPerfNoticeShown(id, now)
  const copy = copyFor(notice)
  toast(copy.title, {
    id: perfNoticeToastId(id),
    description: copy.description,
    duration: Infinity,
    classNames: TRAILING_ACTIONS_CLASS_NAMES,
    action: copy.action,
    cancel: {
      label: translate('perfNotices.dontShowAgain', "Don't show again"),
      onClick: () => {
        const { settings, updateSettings } = useAppStore.getState()
        void updateSettings({ perfNoticesOff: withPerfNoticeOff(settings, id, true) })
      }
    },
    // Why: the close button is "not now": the notice stays quiet for its snooze window.
    onDismiss: () => snoozePerfNotice(id, Date.now())
  })
}
