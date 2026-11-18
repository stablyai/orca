import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { BOT_ACCESS_COPY, botAccessPlace } from '../../../../shared/bots/bot-access-copy'
import {
  getExecutionHostLabel,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'

type BotAccessPlaceWords = { computer: string; there: string }

/** The server's name from Settings; null for this computer, or a server with only a generic label. */
function serverName(state: AppState, hostId: ExecutionHostId): string | null {
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    return null
  }
  const label = selectExecutionHostDisplayLabel(state, hostId)
  return label === getExecutionHostLabel(hostId) ? null : label
}

function placeFor(hostId: ExecutionHostId, name: string | null, t: Translate): BotAccessPlaceWords {
  // A paired web window's local host is its server, not the computer showing the page.
  const here = hostId === LOCAL_EXECUTION_HOST_ID && !isPairedWebClientWindow()
  return botAccessPlace(here ? { kind: 'this-computer' } : { kind: 'server', name }, (id) =>
    t(`bots.access.${id}`, BOT_ACCESS_COPY[id])
  )
}

export function useBotAccessPlace(hostId: ExecutionHostId): BotAccessPlaceWords {
  const t = useTranslate()
  const name = useAppStore((state) => serverName(state, hostId))
  return placeFor(hostId, name, t)
}
