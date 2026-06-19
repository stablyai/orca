export type ShellOpenLocalPathFailureReason = 'not-absolute' | 'not-found' | 'launch-failed'

export type ShellOpenLocalPathResult =
  | { ok: true }
  | { ok: false; reason: ShellOpenLocalPathFailureReason }
