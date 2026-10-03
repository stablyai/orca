/**
 * The one place that defines how an incognito ("no-session") PTY suppresses every
 * shell's on-disk command history, shared by the local daemon
 * (`withHistoryIsolation`) and the SSH relay (`applyRelayIncognitoEnv`) so the two
 * transports cannot drift apart on what "incognito" means for history.
 *
 * Why each knob, per shell × platform:
 *  - bash (every platform): honours `HISTFILE=/dev/null` directly; `HISTSIZE=0` is belt.
 *  - zsh on Linux: honours `HISTFILE=/dev/null` directly.
 *  - zsh on macOS: `/etc/zshrc` reassigns `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history`
 *    unconditionally AFTER this env is applied, so `HISTFILE` alone is a false promise.
 *    `ORCA_HISTFILE=/dev/null` is load-bearing twice over: (a) the zsh wrapper's history
 *    feature is selected only when `ORCA_HISTFILE` is set (see `selectShellStartupFeatures`),
 *    so without it an incognito pane runs UNWRAPPED and never repairs the clobber; and
 *    (b) the wrapper's deferred hook restores `HISTFILE` from `ORCA_HISTFILE` after the
 *    user's config has run, pinning it back to `/dev/null`.
 *  - fish (every platform): ignores `HISTFILE` entirely and keys history off its own
 *    store; `fish_private_mode=1` is the documented switch that stops fish writing any
 *    `*_history` file, the equivalent of `fish --private`.
 *  - WSL (bash/fish guests): none of the above crosses the Windows→guest boundary unless
 *    the key is listed in `WSLENV`; `INCOGNITO_HISTORY_WSLENV_KEYS` is that carrier list.
 *
 * It sets `ORCA_INCOGNITO=1` too, so the inner program (e.g. a private AI CLI) can detect
 * it is running private. It deliberately does NOT mint any scoped history file: callers
 * must skip their normal `injectHistoryEnv`/`injectRelayHistoryEnv`/fish-history injection
 * for an incognito spawn, exactly as the daemon's non-incognito branch does.
 */

/** Keys an incognito PTY must carry over WSLENV so the guest shell inherits them. */
export const INCOGNITO_HISTORY_WSLENV_KEYS = [
  'ORCA_INCOGNITO',
  'HISTFILE',
  'ORCA_HISTFILE',
  'HISTSIZE',
  'fish_private_mode'
] as const

/** Stamp the incognito history-suppression env onto a spawn env, in place. */
export function applyIncognitoHistoryEnv(env: Record<string, string>): void {
  env.ORCA_INCOGNITO = '1'
  // bash + zsh (Linux) read this directly; on macOS it is restored from ORCA_HISTFILE below.
  env.HISTFILE = '/dev/null'
  env.HISTSIZE = '0'
  // Selects the zsh history wrapper AND is what the wrapper restores HISTFILE from after
  // macOS /etc/zshrc clobbers it. Pointed at /dev/null, that restore pins history off.
  env.ORCA_HISTFILE = '/dev/null'
  // fish ignores HISTFILE; private mode is the only lever that stops it writing its store.
  env.fish_private_mode = '1'
}
