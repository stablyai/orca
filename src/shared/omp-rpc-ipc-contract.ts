// IPC-level contract between the renderer and the main-process OMP RPC probe.
// Separate from omp-rpc-protocol.ts (the frozen OMP wire contract): this file
// describes only what crosses Orca's own IPC boundary, which is always a
// fail-closed result union — the handlers never throw across IPC.

import type { OmpRpcSlashCommand } from './omp-rpc-protocol'

/** Local commands the probe may execute. Milestone 1 ships exactly `/usage`:
 *  it is read-only, session-less, and returns its whole answer as
 *  command_output with agentInvoked=false. Anything that mutates session state
 *  (`/compact`, `/clear`) would need the pane's real session, which the probe
 *  deliberately does not own. */
export const OMP_RPC_LOCAL_COMMAND_ALLOWLIST: readonly string[] = ['/usage']

export function isAllowedOmpRpcLocalCommand(command: string): boolean {
  return OMP_RPC_LOCAL_COMMAND_ALLOWLIST.includes(command.trim().toLowerCase())
}

/** Fail-closed reasons a probe call can return. The renderer degrades to its
 *  static catalog / PTY path on every one of them, so they exist to explain a
 *  fallback rather than to be surfaced as errors. */
export type OmpRpcErrorCode =
  | 'executable-not-found'
  | 'spawn-failed'
  | 'not-ready'
  | 'not-allowed'
  | 'request-failed'

export type OmpRpcGetCommandsResult =
  | { ok: true; commands: OmpRpcSlashCommand[] }
  | { ok: false; errorCode: OmpRpcErrorCode }

export type OmpRpcRunLocalCommandResult =
  | {
      ok: true
      /** Concatenated command_output text emitted before the prompt settled. */
      outputText: string
      /** False for a local command — the UI must NOT fabricate an assistant turn. */
      agentInvoked: boolean
      /** True when outputText hit the byte cap and was truncated. */
      truncated?: boolean
    }
  | { ok: false; errorCode: OmpRpcErrorCode }

export type OmpRpcGetCommandsArgs = { cwd: string }
export type OmpRpcRunLocalCommandArgs = { cwd: string; command: string }
