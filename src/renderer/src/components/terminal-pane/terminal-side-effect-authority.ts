import type { GlobalSettings } from '../../../../shared/global-settings-types'

// Why: cached once per session — the blocking read should only ever run on
// the pre-hydration startup path, never per pane bind.
let persistedAuthorityFlagCache: boolean | null | undefined

function readPersistedSideEffectAuthorityFlagSync(): boolean | null {
  if (persistedAuthorityFlagCache === undefined) {
    try {
      const getSync = (globalThis as { window?: Window }).window?.api?.settings?.getSync
      persistedAuthorityFlagCache =
        typeof getSync === 'function' ? (getSync()?.terminalMainSideEffectAuthority ?? null) : null
    } catch {
      persistedAuthorityFlagCache = null
    }
  }
  return persistedAuthorityFlagCache
}

/**
 * Structural authority predicate: main owns side effects for a PTY when its
 * bytes transit local main (everything except remote-runtime PTYs) and the
 * kill switch is on. Decided at transport/watcher creation — never per chunk —
 * so each fact has one consumer with no race.
 */
export function isMainTerminalSideEffectAuthorityForPty(args: {
  settings: Pick<GlobalSettings, 'terminalMainSideEffectAuthority'> | null
  /** Remote-runtime owner environment; null means bytes transit local main. */
  runtimeEnvironmentId: string | null
}): boolean {
  if (args.runtimeEnvironmentId !== null) {
    return false
  }
  if (args.settings !== null) {
    return args.settings.terminalMainSideEffectAuthority !== false
  }
  // Why: settings hydrate asynchronously, and the authority decision made
  // here at transport/watcher creation is never revisited. A pane bound
  // before hydration must honor the persisted kill switch — otherwise a user
  // who turned main authority off gets startup panes with no byte parsers
  // and a fact consumer they disabled. Surfaces without the sync read (web
  // remote clients, tests) keep the default-on behavior.
  return readPersistedSideEffectAuthorityFlagSync() !== false
}

export function resetTerminalSideEffectAuthorityForTest(): void {
  persistedAuthorityFlagCache = undefined
}
