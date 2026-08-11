/**
 * The `TERM_PROGRAM` Orca advertises to processes it spawns.
 *
 * TUIs feature-gate on `TERM_PROGRAM`, and the tables they gate on are
 * allowlists of terminals their authors have heard of. `Orca` is in none of
 * them, so it lands in an "unknown terminal" bucket that is deliberately
 * fail-closed — capabilities Orca genuinely has get switched off.
 *
 * grok is the concrete case: it computes every link's row, column span, URL,
 * and a shared id grouping one link across wrapped rows, then discards all of
 * it because an unknown brand reports `osc8: Unknown`. Orca is left re-deriving
 * URLs from raw screen text, which cannot be done reliably for a URL wrapped at
 * the TUI's own block width.
 *
 * Claiming the VS Code family is the accurate answer to the question these
 * tables are really asking. They are proxies for "which renderer am I talking
 * to", and VS Code's terminal is xterm.js — the same renderer Orca uses, at a
 * newer version. Every capability keyed off that brand (OSC 8 with `id=`,
 * skipping Kitty keyboard negotiation because xterm.js mis-encodes shifted
 * printable keys) is a property Orca shares for the same underlying reason.
 *
 * Orca's true identity stays available as `ORCA_TERM_PROGRAM`.
 */
export const ORCA_ADVERTISED_TERM_PROGRAM = 'vscode'

/** Orca's real brand, preserved alongside the advertised one. */
export const ORCA_TRUE_TERM_PROGRAM = 'Orca'

/**
 * Sets the advertised brand on a spawn environment, recording the true one.
 *
 * Applied to every PTY rather than per agent: `TERM_PROGRAM` is read at process
 * start, so scoping it to Orca-launched agents would miss the common case of a
 * user typing the agent's name into an already-running shell.
 */
export function applyOrcaTerminalBrandEnv(env: Record<string, string>): void {
  env.ORCA_TERM_PROGRAM = ORCA_TRUE_TERM_PROGRAM
  env.TERM_PROGRAM = ORCA_ADVERTISED_TERM_PROGRAM
}
