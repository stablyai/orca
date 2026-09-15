import { omitPairingLocalUiFields } from '../../../../shared/pairing-local-ui-fields'
import type { PairedUiState } from '../../../../shared/pairing-local-ui-fields'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import { STATUS_BAR_CURSOR_ITEM_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { getRemoteRuntimeStatus } from './web-runtime-calls'

export async function prepareHostUiUpdates(
  updates: Partial<PersistedUIState>
): Promise<Partial<PairedUiState>> {
  const hostUpdates = omitPairingLocalUiFields(updates)
  if (!hostUpdates.statusBarItems?.includes('cursor')) {
    return hostUpdates
  }
  const status = await getRemoteRuntimeStatus()
  if (status.capabilities?.includes(STATUS_BAR_CURSOR_ITEM_RUNTIME_CAPABILITY)) {
    return hostUpdates
  }
  // Older hosts reject the entire update when their item enum receives Cursor.
  return {
    ...hostUpdates,
    statusBarItems: hostUpdates.statusBarItems.filter((item) => item !== 'cursor')
  }
}
