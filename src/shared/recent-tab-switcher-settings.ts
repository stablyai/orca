import type { CtrlTabOrderMode, CtrlTabScope } from './tab-types'

/** Ctrl+Tab switcher preferences; optional because older profiles predate them. */
export type RecentTabSwitcherSettings = {
  /** How Ctrl+Tab picks the next visible tab; readers default to MRU. */
  ctrlTabOrderMode?: CtrlTabOrderMode
  /** Which tabs Ctrl+Tab lists; Ctrl+A in the switcher flips it. Readers default to the workspace. */
  ctrlTabScope?: CtrlTabScope
}
