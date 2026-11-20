import { toast } from 'sonner'
import { ArrowRight, Lightbulb } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { TRAILING_ACTIONS_CLASS_NAMES } from '@/components/ui/sonner'
import { getEffectiveBrowserMemorySaverHours } from '../../../../shared/browser/guest-lifecycle/browser-memory-saver'
import { withPerfNoticeOff } from '../../../../shared/perf-notices/perf-notice-settings'
import { recordPerfNoticeShown, snoozePerfNotice } from './perf-notice-ledger'

export type PerfNotice =
  | { id: 'hidden-browser-tabs'; count: number; hours: number }
  | { id: 'disk-almost-full' }

type Copy = {
  title: string
  description: string
  action?: { label: React.ReactNode; onClick: () => void }
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
        // Why: the count and hours are the trigger itself, so the notice says what it found.
        description:
          notice.hours === 1
            ? translate(
                'perfNotices.hiddenTabs.descriptionOneHour',
                "You have {{count}} tabs you haven't viewed in over an hour. Turn on Memory Saver to free up their memory.",
                {
                  count: notice.count,
                  defaultValue_one:
                    "You have {{count}} tab you haven't viewed in over an hour. Turn on Memory Saver to free up its memory."
                }
              )
            : translate(
                'perfNotices.hiddenTabs.description',
                "You have {{count}} tabs you haven't viewed in over {{hours}} hours. Turn on Memory Saver to free up their memory.",
                {
                  count: notice.count,
                  hours: notice.hours,
                  defaultValue_one:
                    "You have {{count}} tab you haven't viewed in over {{hours}} hours. Turn on Memory Saver to free up its memory."
                }
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
        description: translate(
          'perfNotices.disk.description',
          'Find workspaces you no longer need in Settings > Workspace Cleanup.'
        ),
        action: {
          // Why: the arrow marks a button that opens another page, as Orca's other "go to" buttons do.
          label: (
            <span className="inline-flex items-center gap-1.5">
              {translate('perfNotices.disk.reviewOld', 'Review old workspaces')}
              <ArrowRight className="size-3.5" aria-hidden />
            </span>
          ),
          onClick: () => {
            const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
            // Why: the full disk is this machine's, even when Settings last showed a remote host.
            openSettingsTarget({
              pane: 'workspace-cleanup',
              repoId: null,
              hostScope: { kind: 'local' }
            })
            openSettingsPage()
          }
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
    // Why: a lightbulb marks a suggestion, not an alert or an error.
    icon: <Lightbulb className="size-4 text-muted-foreground" />,
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
