export const PTY_OWNERSHIP_CAPTURE_METHODS = {
  begin: 'pty.ownershipTransfer.captureBegin',
  inspect: 'pty.ownershipTransfer.captureInspect',
  select: 'pty.ownershipTransfer.captureSelectBaseline',
  recoverSelection: 'pty.ownershipTransfer.captureRecoverSelection',
  release: 'pty.ownershipTransfer.captureRelease'
} as const

export function parsePtyOwnershipCaptureToken(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new Error('pty_ownership_capture_token_invalid')
  }
  return value
}
