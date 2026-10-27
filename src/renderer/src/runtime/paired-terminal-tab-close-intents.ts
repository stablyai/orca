import {
  MAX_PAIRED_TERMINAL_TAB_CLOSE_INTENTS,
  PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS,
  pairedTerminalTabCloseIntentKey,
  type PairedTerminalTabCloseIntent
} from '../../../shared/paired-terminal-tab-close-intent'
import {
  appendEnvironmentCloseIntents,
  removeEnvironmentCloseIntents,
  type EnvironmentCloseIntentList
} from './environment-close-intent-list'

export type PairedTerminalTabCloseIntentsByEnvironment = Record<
  string,
  PairedTerminalTabCloseIntent[]
>

const PAIRED_TERMINAL_TAB_CLOSE_INTENT_LIST: EnvironmentCloseIntentList<PairedTerminalTabCloseIntent> =
  {
    keyOf: pairedTerminalTabCloseIntentKey,
    maxPerEnvironment: MAX_PAIRED_TERMINAL_TAB_CLOSE_INTENTS,
    maxAgeMs: PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS
  }

/** Adds a held close, newest last, bounded per environment. Returns null if unchanged. */
export function recordPairedTerminalTabCloseIntent(
  current: PairedTerminalTabCloseIntentsByEnvironment,
  environmentId: string,
  intent: PairedTerminalTabCloseIntent
): PairedTerminalTabCloseIntentsByEnvironment | null {
  return appendEnvironmentCloseIntents(PAIRED_TERMINAL_TAB_CLOSE_INTENT_LIST, current, [
    { environmentId, intent }
  ])
}

/** Drops the named intents plus anything past the give-up bound. Returns null if unchanged. */
export function clearPairedTerminalTabCloseIntents(
  current: PairedTerminalTabCloseIntentsByEnvironment,
  args: { environmentId: string; intentKeys: readonly string[]; now: number }
): PairedTerminalTabCloseIntentsByEnvironment | null {
  return removeEnvironmentCloseIntents(PAIRED_TERMINAL_TAB_CLOSE_INTENT_LIST, current, {
    environmentId: args.environmentId,
    keys: args.intentKeys,
    now: args.now
  })
}

/** Only the closes owed to a server the catalog still lists; the rest can never be sent. */
export function retainPairedTerminalTabCloseIntentsForCatalog(
  intents: PairedTerminalTabCloseIntentsByEnvironment,
  catalog: { hydrated: boolean; environmentIds: readonly string[] }
): PairedTerminalTabCloseIntentsByEnvironment {
  if (!catalog.hydrated) {
    return intents
  }
  const listed = new Set(catalog.environmentIds)
  return Object.fromEntries(Object.entries(intents).filter(([id]) => listed.has(id)))
}
