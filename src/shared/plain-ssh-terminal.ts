/** The plain SSH terminal's IPC contract: open by saved target id, then talk by session id. */
export const PLAIN_SSH_TERMINAL_CHANNELS = {
  open: 'plainSsh:open',
  write: 'plainSsh:write',
  resize: 'plainSsh:resize',
  close: 'plainSsh:close',
  /** Output the window has rendered, in UTF-16 units of `data`; ssh is paused while too much is unrendered. */
  ack: 'plainSsh:ack',
  event: 'plainSsh:event'
} as const

export type PlainSshTerminalOpenResult =
  | { ok: true; sessionId: string; label: string }
  /** `already-open`: another window holds this host's one session. */
  | { ok: false; reason: 'unknown-target' | 'not-blocked' | 'already-open' }
  /** A newer open from the same window, a reload or quit took this one's place. */
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'ssh-missing' | 'spawn-failed'; message: string }

export type PlainSshTerminalEvent =
  | { kind: 'data'; sessionId: string; data: string }
  /** `signal`: set when ssh was killed, so a zero `exitCode` is not a clean logout. */
  | { kind: 'exit'; sessionId: string; exitCode: number; signal?: number }
