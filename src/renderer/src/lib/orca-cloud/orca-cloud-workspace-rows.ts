// PAIRED-CHROME: which sidebar rows have Orca Cloud status, beside the store (its line budget is spent).
// Owned rows are this desktop's own cloud workspaces (`ids`); PAIRED rows are a "<name> (cloud)"
// server's own checkout, registered by PAIRED-STATUS (`paired`). Both read status the same way.
import type { CloudWorkspaceSnapshot } from './orca-cloud-workspace-store'

/** A row with cloud status: this desktop's own cloud workspace, or a PAIRED one's own row. */
export const isCloudStatusRow = (state: CloudWorkspaceSnapshot, id: string): boolean =>
  state.ids.has(id) || Object.hasOwn(state.paired, id)
/** Paired only: PAIRED-CHROME's hides of actions main can't run for it yet key on this. */
export const isPairedCloudStatusRow = (state: CloudWorkspaceSnapshot, id: string): boolean =>
  !state.ids.has(id) && Object.hasOwn(state.paired, id)
