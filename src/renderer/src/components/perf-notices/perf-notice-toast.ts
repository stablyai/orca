import { toast } from 'sonner'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { TRAILING_ACTIONS_CLASS_NAMES } from '@/components/ui/sonner'
import { DEFAULT_NATIVE_CHAT_IDLE_STOP_MINUTES } from '../../../../shared/native-chat/settings/native-chat-idle-stop'
import { getEffectiveBrowserMemorySaverHours } from '../../../../shared/browser/guest-lifecycle/browser-memory-saver'
import { requestResourceManagerOpen } from '../status-bar/resources/resource-manager-open-request'
import {
  recordPerfNoticeShown,
  snoozePerfNotice,
  turnOffPerfNotice,
  type PerfNoticeId
} from './perf-notice-ledger'
import type { IdleAgents } from './perf-notice-rules'

export type PerfNotice =
  | { id: 'memory-low'; variant: 'agent-sleep' | 'agents' | 'your-terminals' | 'terminals' }
  | { id: 'idle-agents'; idle: IdleAgents }
  | { id: 'hidden-browser-tabs'; count: number; hours: number }
  | { id: 'disk-almost-full'; freeLabel: string }

type Copy = { title: string; description: string; action: string; run: () => void }

/** The hours Memory Saver will use once on, so the copy matches what the button does. */
export function memorySaverHours(): number {
  return getEffectiveBrowserMemorySaverHours(
    useAppStore.getState().settings?.browserMemorySaverHours
  )
}

function formatList(items: readonly string[]): string {
  return new Intl.ListFormat(getIntlLocale(), { style: 'long', type: 'conjunction' }).format(items)
}

function copyFor(notice: PerfNotice): Copy {
  const openResources = translate('perfNotices.openResources', 'Open Resources')
  switch (notice.id) {
    case 'memory-low': {
      const title = translate('perfNotices.memoryLow.title', 'Memory is low')
      if (notice.variant === 'agent-sleep') {
        return {
          title,
          description: translate(
            'perfNotices.memoryLow.agentSleep',
            'Agent Sleep frees memory from idle agents. They resume when you open them.'
          ),
          action: translate('perfNotices.memoryLow.turnOnAgentSleep', 'Turn on Agent Sleep'),
          run: () =>
            void useAppStore.getState().updateSettings({ experimentalAgentHibernation: true })
        }
      }
      return {
        title,
        description:
          notice.variant === 'agents'
            ? translate(
                'perfNotices.memoryLow.agents',
                'Terminal agents are using most of it. Resources shows what each one uses.'
              )
            : notice.variant === 'your-terminals'
              ? translate(
                  'perfNotices.memoryLow.yourTerminals',
                  'Your terminals are using most of it. Resources shows what each one uses.'
                )
              : translate(
                  'perfNotices.memoryLow.terminals',
                  'Agents and terminals in Orca are using most of it. Resources shows what each one uses.'
                ),
        action: openResources,
        run: requestResourceManagerOpen
      }
    }
    case 'idle-agents': {
      const { terminal, chats, terminalLabels } = notice.idle
      const autoStop = {
        description: translate(
          'perfNotices.idleAgents.autoStop',
          'Their agents are still using memory. Auto-stop pauses idle chats, and they pick up again when you send a message.'
        ),
        action: translate('perfNotices.idleAgents.turnOnAutoStop', 'Turn on auto-stop'),
        run: () =>
          void useAppStore
            .getState()
            .updateSettings({ nativeChatIdleStopMinutes: DEFAULT_NATIVE_CHAT_IDLE_STOP_MINUTES })
      }
      if (terminal === 0) {
        return {
          title: translate(
            'perfNotices.idleAgents.chats',
            '{{count}} chats have been idle for 2 hours',
            {
              count: chats,
              defaultValue_one: '{{count}} chat has been idle for 2 hours'
            }
          ),
          ...autoStop
        }
      }
      if (chats > 0) {
        return {
          title: translate(
            'perfNotices.idleAgents.mixed',
            '{{terminal}} and {{chats}} have been idle for 2 hours',
            {
              terminal: translate(
                'perfNotices.idleAgents.terminalCount',
                '{{count}} terminal agents',
                {
                  count: terminal,
                  defaultValue_one: '{{count}} terminal agent'
                }
              ),
              chats: translate('perfNotices.idleAgents.chatCount', '{{count}} chats', {
                count: chats,
                defaultValue_one: '{{count}} chat'
              })
            }
          ),
          ...autoStop
        }
      }
      return {
        title: translate(
          'perfNotices.idleAgents.terminal',
          '{{count}} terminal agents have been idle for 2 hours',
          {
            count: terminal,
            defaultValue_one: '{{count}} terminal agent has been idle for 2 hours'
          }
        ),
        description: translate(
          'perfNotices.idleAgents.terminalDescription',
          "{{agents}} sessions are still using memory. End the ones you're done with in Resources.",
          { agents: formatList(terminalLabels) }
        ),
        action: openResources,
        run: requestResourceManagerOpen
      }
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
          "Memory Saver frees tabs you haven't viewed in {{count}} hours. They reload when you open them.",
          {
            count: notice.hours,
            defaultValue_one:
              "Memory Saver frees tabs you haven't viewed in {{count}} hour. They reload when you open them."
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
  const id: PerfNoticeId = notice.id
  const shownCount = recordPerfNoticeShown(id, now)
  const copy = copyFor(notice)
  const secondShowing = shownCount > 1
  toast(copy.title, {
    id: `perf-notice-${id}`,
    description: copy.description,
    duration: Infinity,
    classNames: TRAILING_ACTIONS_CLASS_NAMES,
    action: { label: copy.action, onClick: copy.run },
    cancel: {
      label: secondShowing
        ? translate('perfNotices.dontShowAgain', "Don't show again")
        : translate('perfNotices.notNow', 'Not now'),
      onClick: () => (secondShowing ? turnOffPerfNotice(id) : snoozePerfNotice(id, Date.now()))
    },
    // Why: the close button snoozes like Not now, so a dismissed notice stays quiet for its window.
    onDismiss: () => snoozePerfNotice(id, Date.now())
  })
}
