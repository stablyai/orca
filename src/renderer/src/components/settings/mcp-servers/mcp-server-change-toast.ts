// After a change to a host's servers, or after a host starts: a restart for the host's running
// terminal sessions that still have the old list.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  readStaleMcpSessions,
  restartStaleMcpSessions
} from '@/runtime/mcp-servers/mcp-servers-client'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'

// One toast for a run of changes: the newest replaces the last instead of stacking.
const TOAST_ID = 'mcp-servers-changed'

export async function showMcpServerChangeToast(
  target: RuntimeClientTarget,
  title: string
): Promise<void> {
  const description = translate('settings.mcpServers.toast.newSessions', 'Applies to new sessions')
  // A host that can't count them yet (or any failure to) offers no restart.
  const stale = await readStaleMcpSessions(target).catch(() => ({ count: 0, restartable: 0 }))
  toast(title, { id: TOAST_ID, description, ...restartAction(target, stale.restartable) })
}

/**
 * After a host starts: its agent terminals still on an older list. Those that outlived its restart
 * lost every server that goes through its relay with the old run. Nothing when there are none.
 * False when the host couldn't be asked.
 */
export async function showMcpStaleTerminalsToast(
  target: RuntimeClientTarget,
  hostName: string | null,
  current: () => boolean
): Promise<boolean> {
  const stale = await readStaleMcpSessions(target).catch(() => null)
  if (!current() || !stale) {
    return stale !== null
  }
  if (stale.count === 0) {
    // An earlier run's offer, if still up, has nothing left to restart.
    toast.dismiss(mcpStaleTerminalsToastId(target))
    return true
  }
  const count = stale.count
  const title =
    hostName === null
      ? translate(
          'settings.mcpServers.toast.staleTerminals',
          '{{count}} agent terminals use an older MCP setup',
          { count, defaultValue_one: '{{count}} agent terminal uses an older MCP setup' }
        )
      : translate(
          'settings.mcpServers.toast.staleTerminalsOnHost',
          '{{count}} agent terminals on {{host}} use an older MCP setup',
          {
            count,
            host: hostName,
            defaultValue_one: '{{count}} agent terminal on {{host}} uses an older MCP setup'
          }
        )
  toast(title, {
    id: mcpStaleTerminalsToastId(target),
    description: staleTerminalsRestartLine(count, stale.restartable),
    // Their tools stay broken until they restart, so the offer waits to be seen.
    duration: Infinity,
    closeButton: true,
    ...restartAction(target, stale.restartable)
  })
  return true
}

/** What restarting does for them: the button resumes those with a conversation, and the rest the
 *  user restarts themselves. */
function staleTerminalsRestartLine(count: number, restartable: number): string {
  if (restartable >= count) {
    return translate(
      'settings.mcpServers.toast.staleTerminalsRestart',
      'Restart them to reconnect Orca’s MCP servers.',
      { count, defaultValue_one: 'Restart it to reconnect Orca’s MCP servers.' }
    )
  }
  if (restartable === 0) {
    return translate(
      'settings.mcpServers.toast.staleTerminalsRestartManual',
      'Restart them yourself to reconnect Orca’s MCP servers.',
      { count, defaultValue_one: 'Restart it yourself to reconnect Orca’s MCP servers.' }
    )
  }
  return translate(
    'settings.mcpServers.toast.staleTerminalsRestartSome',
    '{{restartable}} can be resumed here. Restart the other {{count}} yourself.',
    {
      count: count - restartable,
      restartable,
      defaultValue_one: '{{restartable}} can be resumed here. Restart the other one yourself.'
    }
  )
}

export const mcpStaleTerminalsToastId = (target: RuntimeClientTarget): string =>
  `mcp-stale-terminals:${target.kind === 'local' ? 'local' : target.environmentId}`

function restartAction(target: RuntimeClientTarget, restartable: number) {
  if (restartable === 0) {
    return {}
  }
  return {
    action: {
      label: translate('settings.mcpServers.toast.restart', 'Restart {{count}} sessions', {
        count: restartable,
        defaultValue_one: 'Restart {{count}} session'
      }),
      onClick: () => {
        void restartStaleMcpSessions(target).catch((error: unknown) =>
          toast.error(botToolErrorMessage(error))
        )
      }
    }
  }
}
