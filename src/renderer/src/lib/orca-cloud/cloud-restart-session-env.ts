// RA-11: an account restart types its launch command into the pane's existing shell, whose env was
// captured before the account was stored or renewed. On an Orca Cloud VM the image's `orca-env`
// prints the current session env (placeholders, never real values), so the relaunched agent picks
// up the renewed account. Other hosts: unchanged.
import { useAppStore } from '@/store'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { isOrcaCloudEnvironmentId } from './orca-cloud-environment-id'

/** The prefix that refreshes a cloud shell's session env before the command; quiet off-cloud. */
export const ORCA_CLOUD_SESSION_ENV_REFRESH = 'eval "$(orca-env 2>/dev/null)"; '

/** True when this pane's terminal runs on an Orca Cloud sandbox. */
export function isOrcaCloudPane(pane: { tabId: string; leafId: string }): boolean {
  const ptyId =
    useAppStore.getState().terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId] ?? null
  const environmentId = ptyId ? parseRemoteRuntimePtyId(ptyId)?.environmentId : null
  return Boolean(environmentId && isOrcaCloudEnvironmentId(environmentId))
}

export function withOrcaCloudSessionEnv<T extends { command: string }>(
  startup: T,
  pane: { tabId: string; leafId: string }
): T {
  if (!isOrcaCloudPane(pane)) {
    return startup
  }
  return startup.command.startsWith(ORCA_CLOUD_SESSION_ENV_REFRESH)
    ? startup
    : { ...startup, command: `${ORCA_CLOUD_SESSION_ENV_REFRESH}${startup.command}` }
}
