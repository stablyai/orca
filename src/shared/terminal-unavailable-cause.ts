/**
 * The machine-readable half of "remote terminals are unavailable".
 *
 * Why this exists: the fault is proved on the relay, at spawn time, and the machinery
 * that can repair it (`repairInstalledNativeDeps`) lives on the client, at connect time.
 * Until now the only thing that crossed the wire was prose, so the client could not tell
 * a rebuildable ABI flip from a host whose glibc will never satisfy the binary — and the
 * message had to hedge across all of them.
 *
 * Wire compatibility (docs/reference/remote-wire-compatibility.md): this rides as the
 * optional `data` of an existing JSON-RPC error, so it is Rule 1 — additive. A client
 * that does not read it still renders `error.message`, which is exactly today's
 * behaviour, so no capability negotiation is needed.
 *
 * `repairable` is the field with teeth: it is true only for a fault that was PROVED and
 * that rebuilding node-pty on the host actually fixes. An `unverifiable` cause is never
 * repairable — a probe that did not answer must not trigger a destructive repair, which
 * is the #14830 lesson recorded in docs/reference/ssh-execution-boundary.md.
 */
import { z } from 'zod'
import { TERMINAL_UNAVAILABLE_ERROR_CODE } from './runtime-capability-degradation'

export const TERMINAL_UNAVAILABLE_RPC_ERROR_CODE = TERMINAL_UNAVAILABLE_ERROR_CODE

const TerminalUnavailableHostSchema = z
  .object({
    platform: z.string().min(1).max(32),
    arch: z.string().min(1).max(32),
    libc: z.enum(['glibc', 'musl', 'none']),
    /** Absent, not null, when the host reports no version — see native-host-abi.ts. */
    glibcVersion: z.string().min(1).max(32).optional(),
    /** `NODE_MODULE_VERSION` the remote runtime accepts. */
    nodeAbi: z.string().min(1).max(16),
    nodeVersion: z.string().min(1).max(32)
  })
  .strict()

export const TerminalUnavailableCauseSchema = z
  .object({
    /** `blocked` — proved. `unverifiable` — nothing answered; never act on it. */
    status: z.enum(['blocked', 'unverifiable']),
    /**
     * Open vocabulary, deliberately `string` rather than an enum: a newer relay may name a
     * reason this client has never heard of, and a strict enum would drop the whole cause
     * (including `repairable`) rather than the one field it cannot interpret.
     */
    reason: z.string().min(1).max(64),
    detail: z.string().max(400),
    /** Proved, and rebuilding node-pty on the host is the fix. */
    repairable: z.boolean(),
    host: TerminalUnavailableHostSchema,
    /** The dynamic loader's own words, when they were recovered. */
    rawError: z.string().max(1000).optional()
  })
  .strict()

export type TerminalUnavailableCause = z.infer<typeof TerminalUnavailableCauseSchema>

/** Null for anything that does not validate; a malformed cause must never be acted on. */
export function parseTerminalUnavailableCause(value: unknown): TerminalUnavailableCause | null {
  const parsed = TerminalUnavailableCauseSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * The cause carried by a rejected JSON-RPC call, or null when there is none to act on.
 *
 * Reads `data`, never `code`: the dispatcher coerces a non-numeric error code to -32000 on the
 * way out, so the string code does not survive the wire. The strict schema is the whole gate —
 * no other published `data` shape validates against it.
 */
export function terminalUnavailableCauseFromError(error: unknown): TerminalUnavailableCause | null {
  if (typeof error !== 'object' || error === null || !('data' in error)) {
    return null
  }
  return parseTerminalUnavailableCause((error as { data: unknown }).data)
}

/**
 * Whether the client may rewrite the host's `node_modules` on the strength of this cause.
 *
 * Deliberately re-derived here rather than trusting `repairable` alone: the flag arrives
 * from a peer, and only a `blocked` status is evidence of anything.
 */
export function mayRepairFromCause(cause: TerminalUnavailableCause | null): boolean {
  return cause !== null && cause.status === 'blocked' && cause.repairable
}
