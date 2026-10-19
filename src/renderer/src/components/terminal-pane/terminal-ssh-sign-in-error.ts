import { compactIpcErrorMessage } from '@/lib/ipc-error'
import {
  SSH_SIGN_IN_AWAITED_SUFFIX,
  SSH_SIGN_IN_CANCELLED_SUFFIX
} from '../../../../shared/ssh-sign-in-required-copy'

function isSignInLine(line: string): boolean {
  return line.endsWith(SSH_SIGN_IN_AWAITED_SUFFIX) || line.endsWith(SSH_SIGN_IN_CANCELLED_SUFFIX)
}

/** The host is waiting for the user to sign in: an expected state, not a bug to report. */
export function isSshSignInRequiredTerminalError(error: string): boolean {
  const lines = error.split('\n').filter((line) => line.trim().length > 0)
  return lines.length > 0 && lines.every(isSignInLine)
}

/** Drops Electron's IPC wrapper so the toast reads as the sentence main wrote. */
export function describeSshSignInRequiredTerminalError(error: string): string {
  return error
    .split('\n')
    .map((line) => (isSignInLine(line) ? (compactIpcErrorMessage(line) ?? line) : line))
    .join('\n')
}
