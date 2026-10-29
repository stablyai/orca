/**
 * Why bytes are written to a PTY. Every host write entry point takes one, so no producer inherits
 * a transport's default.
 * - `driving`: input that drives the run, from a person or any client, driver or agent acting on it.
 * - `orchestration`: driving input Orca writes and submits itself (mail, dispatches, relayed messages), never a draft.
 * - `launch`: bytes Orca writes to start the run: startup commands, a create-time draft or prompt.
 * - `query-reply`: the terminal's automatic answer to a query the running program made.
 */
export type TerminalInputKind = 'driving' | 'orchestration' | 'launch' | 'query-reply'

export function isDrivingInputKind(inputKind: TerminalInputKind): boolean {
  return inputKind === 'driving' || inputKind === 'orchestration'
}
