// Which sidebar rows have Orca Cloud status, beside the store (its line budget is spent).
// Owned rows are this desktop's own cloud workspaces (`ids`); PAIRED rows are a "<name> (cloud)"
// server's own checkout, registered by the paired registry (`paired`). Both read status the same way.
import type { CloudWorkspaceStatus } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { CloudWorkspaceSnapshot } from './orca-cloud-workspace-store'

/** A row with cloud status: this desktop's own cloud workspace, or a PAIRED one's own row. */
export const isCloudStatusRow = (state: CloudWorkspaceSnapshot, id: string): boolean =>
  state.ids.has(id) || Object.hasOwn(state.paired, id)
/** Paired only: hiding the actions main can't run for a paired row yet keys on this. */
export const isPairedCloudStatusRow = (state: CloudWorkspaceSnapshot, id: string): boolean =>
  !state.ids.has(id) && Object.hasOwn(state.paired, id)

/** The last status read says archived (owned or paired, same test as the store's). */
export const isArchivedCloudStatus = (status: CloudWorkspaceStatus | null | undefined): boolean =>
  status?.state === 'archived' || Boolean(status?.archive)
