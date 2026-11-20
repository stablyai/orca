import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import type { RuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { botHostMachineName } from '@/lib/bot-host-status'
import type { AppState } from '@/store/types'
import { BOT_ACCESS_COPY, botAccessPlace } from '../../../../shared/bots/bot-access-copy'
import {
  toRuntimeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'

type BotAccessPlaceWords = { computer: string; there: string }

/** The current host’s verified machine name, when available. */
function serverName(
  state: AppState,
  statuses: RuntimeStatuses,
  hostId: ExecutionHostId
): string | null {
  const web = isPairedWebClientWindow()
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    if (!web || state.runtimeEnvironments?.length !== 1) {
      return null
    }
    hostId = toRuntimeExecutionHostId(state.runtimeEnvironments[0].id)
  }
  return botHostMachineName(hostId, state, statuses)
}

function placeFor(hostId: ExecutionHostId, name: string | null, t: Translate): BotAccessPlaceWords {
  // A paired web window's local host is its server, not the computer showing the page.
  const here = hostId === LOCAL_EXECUTION_HOST_ID && !isPairedWebClientWindow()
  return botAccessPlace(here ? { kind: 'this-computer' } : { kind: 'unknown', name }, (id) =>
    t(`bots.access.${id}`, BOT_ACCESS_COPY[id])
  )
}

export function useBotAccessPlace(hostId: ExecutionHostId): BotAccessPlaceWords {
  const t = useTranslate()
  const name = useAppStoreWithHostStatuses((state, statuses) => serverName(state, statuses, hostId))
  return placeFor(hostId, name, t)
}
