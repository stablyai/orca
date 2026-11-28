// Centralize the layout owner so all branch points are searchable; main enables the new path.
// Read once per process from the internal startup setting (layout-owner-startup.ts); off by default.
import { readStartupLayoutOwner } from './layout-owner-startup'

export const ORCA_LAYOUT_OWNER_IS_MAIN =
  readStartupLayoutOwner(globalThis, (message) => console.warn(message)) === 'main'
