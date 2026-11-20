import { toast } from 'sonner'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { TRAILING_ACTIONS_CLASS_NAMES } from '@/components/ui/sonner'
import { getEffectiveBrowserMemorySaverHours } from '../../../../shared/browser/guest-lifecycle/browser-memory-saver'
import { withPerfNoticeOff } from '../../../../shared/perf-notices/perf-notice-settings'
import { recordPerfNoticeShown, snoozePerfNotice } from './perf-notice-ledger'

export type PerfNotice =
  | { id: 'hidden-browser-tabs' }
  | { id: 'disk-almost-full'; freeLabel: string }

type Copy = {
  title: string
  description: React.ReactNode
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
    case 'disk-almost-full':
      return {
        title: translate('perfNotices.disk.title', 'Your disk is almost full'),
        // Why: name the Resource Manager so users can find cleanup again after the toast is gone.
        description: (
          <p>
            <Trans
              i18n={i18n}
              defaults={translate(
                'perfNotices.disk.description',
                '{{free}} left. Clean up workspaces you no longer need in <link>the Resource Manager</link>.',
                { free: notice.freeLabel }
              )}
              components={{
                link: (
                  <button
                    type="button"
                    onClick={() => {
                      useAppStore.getState().openModal('workspace-cleanup')
                      toast.dismiss(perfNoticeToastId(notice.id))
                    }}
                    className="cursor-pointer font-medium text-popover-foreground underline underline-offset-2 hover:text-primary"
                  />
                )
              }}
            />
          </p>
        )
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
