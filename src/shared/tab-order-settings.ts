import type { CtrlTabOrderMode } from './tab-types'

export type TabOrderSettings = {
  /** How Ctrl+Tab picks the next visible tab; optional (older profiles), readers default to MRU. */
  ctrlTabOrderMode?: CtrlTabOrderMode
  /** Promote tabs on user input or keyboard switching; absent keeps manual ordering. */
  tabBarOrderMode?: 'manual' | 'mru'
}
