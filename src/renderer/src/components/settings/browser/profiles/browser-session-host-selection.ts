import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { Translate } from '@/i18n/use-translate'
import { translateHostDisplayLabel } from '@/runtime/hosts/display/execution-host-label'
import type { SidebarHostOption } from '../../../sidebar/worktree-list/controls/sidebar-host-options'
import type { ProfileCookieClearHost } from './use-profile-cookie-clear'

export type BrowserSessionHostOption = ProfileCookieClearHost & { detail: string }

/** SSH hosts are listed for their pages' cookie jars, which live on this computer. */
export function browserSessionHostOption(
  host: SidebarHostOption,
  t: Translate
): BrowserSessionHostOption {
  return {
    id: host.id,
    kind: host.kind,
    label: translateHostDisplayLabel(host, t),
    detail:
      host.kind === 'local'
        ? t('auto.components.settings.BrowserPane.86b7c83fee', 'This computer')
        : host.kind === 'ssh'
          ? t(
              'settings.browser.sessionHost.sshDetail',
              'Pages for this SSH host open on this computer.'
            )
          : t(
              'auto.components.settings.BrowserPane.c0f85056d9',
              'Browser profiles on this Orca server.'
            )
  }
}

export function resolveAvailableBrowserSessionHostId(
  options: readonly { id: ExecutionHostId }[],
  overrideHostId: ExecutionHostId | null,
  focusedHostId: ExecutionHostId
): ExecutionHostId {
  const availableIds = new Set(options.map((option) => option.id))
  if (overrideHostId && availableIds.has(overrideHostId)) {
    return overrideHostId
  }
  if (availableIds.has(focusedHostId)) {
    return focusedHostId
  }
  return options[0]?.id ?? LOCAL_EXECUTION_HOST_ID
}
