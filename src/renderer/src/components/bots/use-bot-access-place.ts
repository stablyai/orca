import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useAppStore } from '@/store'
import { botHostMachineName } from '@/lib/bot-host-status'
import { hasPendingRuntimeEnvironmentContinuation } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { AppState } from '@/store/types'
import { BOT_ACCESS_COPY, botAccessPlace } from '../../../../shared/bots/bot-access-copy'
import { getHostSettingOverride } from '../../../../shared/execution-host/host-setting-overrides'
import {
  getExecutionHostLabel,
  toRuntimeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'

type BotAccessPlaceWords = { computer: string; there: string }

/** The configured server name; null for a local desktop or a generic server label. */
function serverName(state: AppState, hostId: ExecutionHostId): string | null {
  const web = isPairedWebClientWindow()
  if (hostId === LOCAL_EXECUTION_HOST_ID) {
    if (!web || state.runtimeEnvironments?.length !== 1) {
      return null
    }
    hostId = toRuntimeExecutionHostId(state.runtimeEnvironments[0].id)
  }
  const parsed = parseRoutableExecutionHostId(hostId)
  const pending =
    parsed?.kind === 'runtime' && hasPendingRuntimeEnvironmentContinuation(parsed.environmentId)
  const override = getHostSettingOverride(state.settings, hostId, 'displayLabel')
  if (override && !pending) {
    return override
  }
  const published = botHostMachineName(hostId, state)
  if (published || web || pending) {
    return published
  }
  const label = selectExecutionHostDisplayLabel(state, hostId)
  return label === getExecutionHostLabel(hostId) ? null : label
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
  const name = useAppStore((state) => serverName(state, hostId))
  return placeFor(hostId, name, t)
}
