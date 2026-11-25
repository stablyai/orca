// How New bot's Computer list shows each host: its group, its right-side text, and its fix.
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { hostPlatformDisplayName } from '../../../../shared/execution-host/host-platform-label'
import { botCreateHostBlockedHint, type BotCreateHost } from './bot-create-hosts'

/** `reconnecting` is `reconnect` in progress. */
export type BotCreateHostAction = 'reconnect' | 'reconnecting' | 'update'

export type BotCreateHostRow = {
  host: BotCreateHost
  group: 'ready' | 'unavailable'
  /** OS and other Orca account, or a setup requirement for an SSH-only host. */
  meta: string | null
  /** Not-available rows: the fix, when there is one. */
  action: BotCreateHostAction | null
  /** Why it isn't available, for hover and screen readers. */
  hint: string | null
}

export type BotCreateHostRowsInput = {
  /** Hosts that were ready when the list opened; groups stay put while it is open. Null: now. */
  readyAtOpen: ReadonlySet<ExecutionHostId> | null
  otherAccountOf: (hostId: ExecutionHostId) => string | null
  /** The server-update dialog can update this server. */
  updatable: (environmentId: string) => boolean
  reconnecting: ReadonlySet<string>
}

function hostAction(
  host: BotCreateHost,
  input: BotCreateHostRowsInput
): BotCreateHostAction | null {
  if (!host.environmentId) {
    return null
  }
  if (host.blocked === 'offline') {
    return input.reconnecting.has(host.environmentId) ? 'reconnecting' : 'reconnect'
  }
  if (host.blocked === 'no-bots' && input.updatable(host.environmentId)) {
    return 'update'
  }
  return null
}

/** Ready hosts first, then the rest, each in the order given. */
export function botCreateHostRows(
  hosts: readonly BotCreateHost[],
  input: BotCreateHostRowsInput,
  t: Translate = translate
): BotCreateHostRow[] {
  const rows = hosts.map((host): BotCreateHostRow => {
    const ready = input.readyAtOpen ? input.readyAtOpen.has(host.hostId) : !host.blocked
    if (host.blocked) {
      const updatable = Boolean(host.environmentId && input.updatable(host.environmentId))
      return {
        host,
        group: ready ? 'ready' : 'unavailable',
        meta:
          host.blocked === 'needs-server'
            ? t('bots.new.hostNeedsServer', 'Needs Orca server')
            : null,
        action: hostAction(host, input),
        hint: botCreateHostBlockedHint(host, updatable, t)
      }
    }
    const account = input.otherAccountOf(host.hostId)
    return {
      host,
      group: ready ? 'ready' : 'unavailable',
      meta: host.waking
        ? t('bots.new.hostWaking', 'Waking…')
        : host.sleeping
          ? t('bots.new.hostSleeping', 'Sleeping · wakes when used')
          : [
              hostPlatformDisplayName(host.platform),
              account ? t('bots.new.hostAs', 'as {{account}}', { account }) : null
            ]
              .filter(Boolean)
              .join(' · ') || null,
      action: null,
      hint: null
    }
  })
  return [
    ...rows.filter((row) => row.group === 'ready'),
    ...rows.filter((row) => row.group === 'unavailable')
  ]
}
