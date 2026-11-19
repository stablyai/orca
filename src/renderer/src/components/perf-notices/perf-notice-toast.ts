import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { TRAILING_ACTIONS_CLASS_NAMES } from '@/components/ui/sonner'
import { getEffectiveBrowserMemorySaverHours } from '../../../../shared/browser/guest-lifecycle/browser-memory-saver'
import { withPerfNoticeOff } from '../../../../shared/perf-notices/perf-notice-settings'
import { recordPerfNoticeShown, snoozePerfNotice } from './perf-notice-ledger'

export type PerfNotice =
  | { id: 'hidden-browser-tabs'; count: number; hours: number }
  | { id: 'disk-almost-full'; freeLabel: string }
  | { id: 'memory-low' }
  | { id: 'idle-agents'; count: number }

type Copy = { title: string; description: string; action: string; run: () => void }

/** The hours Memory Saver will use once on, so the copy matches what the button does. */
export function memorySaverHours(): number {
  return getEffectiveBrowserMemorySaverHours(
    useAppStore.getState().settings?.browserMemorySaverHours
  )
}

function turnOnAgentSleep(): void {
  void useAppStore.getState().updateSettings({ experimentalAgentHibernation: true })
}

function agentSleepAction(): string {
  return translate('perfNotices.turnOnAgentSleep', 'Turn on Agent Sleep')
}

function copyFor(notice: PerfNotice): Copy {
  switch (notice.id) {
    case 'memory-low':
      return {
        title: translate('perfNotices.memoryLow.title', 'Memory is low'),
        description: translate(
          'perfNotices.memoryLow.description',
          'Agent Sleep frees memory from idle agents and resumes them when you return.'
        ),
        action: agentSleepAction(),
        run: turnOnAgentSleep
      }
    case 'idle-agents':
      return {
        title: translate(
          'perfNotices.idleAgents.title',
          '{{count}} agents have been idle for 2 hours',
          { count: notice.count }
        ),
        description: translate(
          'perfNotices.idleAgents.description',
          'Agent Sleep frees their memory and resumes them when you return.'
        ),
        action: agentSleepAction(),
        run: turnOnAgentSleep
      }
    case 'hidden-browser-tabs':
      return {
        title: translate(
          'perfNotices.hiddenTabs.title',
          '{{count}} hidden browser tabs are still loaded',
          { count: notice.count }
        ),
        description: translate(
          'perfNotices.hiddenTabs.description',
          "Memory Saver frees tabs you haven't viewed in {{count}} hours.",
          {
            count: notice.hours,
            defaultValue_one: "Memory Saver frees tabs you haven't viewed in {{count}} hour."
          }
        ),
        action: translate('perfNotices.hiddenTabs.turnOnMemorySaver', 'Turn on Memory Saver'),
        run: () =>
          void useAppStore.getState().updateSettings({ browserGuestWorktreeRetentionBudget: true })
      }
    case 'disk-almost-full':
      return {
        title: translate('perfNotices.disk.title', 'Your disk is almost full'),
        description: translate(
          'perfNotices.disk.description',
          '{{free}} left. Clean up workspaces you no longer need to free space.',
          { free: notice.freeLabel }
        ),
        action: translate('perfNotices.disk.cleanUp', 'Clean up workspaces'),
        run: () => useAppStore.getState().openModal('workspace-cleanup')
      }
  }
}

export function showPerfNotice(notice: PerfNotice, now: number): void {
  const id = notice.id
  recordPerfNoticeShown(id, now)
  const copy = copyFor(notice)
  toast(copy.title, {
    id: `perf-notice-${id}`,
    description: copy.description,
    duration: Infinity,
    classNames: TRAILING_ACTIONS_CLASS_NAMES,
    action: { label: copy.action, onClick: copy.run },
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
