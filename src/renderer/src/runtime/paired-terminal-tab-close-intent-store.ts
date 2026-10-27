import { useAppStore } from '../store'
import { pairedTerminalTabCloseIntentStoreOf } from './web-session-close-replay'

/** The app store's held paired-tab closes, as the replay module reads and settles them. */
export const appPairedTerminalTabCloseIntentStore = pairedTerminalTabCloseIntentStoreOf(() =>
  useAppStore.getState()
)
