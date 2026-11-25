// After a change to a host's servers: what changed, that it applies to new sessions, and a restart
// for the host's running terminal sessions that still have the old list.
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
  const restartable = stale.restartable
  toast(title, {
    id: TOAST_ID,
    description,
    ...(restartable > 0
      ? {
          action: {
            label: translate('settings.mcpServers.toast.restart', 'Restart {{count}} sessions', {
              count: restartable
            }),
            onClick: () => {
              void restartStaleMcpSessions(target).catch((error: unknown) =>
                toast.error(botToolErrorMessage(error))
              )
            }
          }
        }
      : {})
  })
}
