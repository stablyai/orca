import { compactIpcErrorMessage } from '@/lib/ipc-error'
import {
  SSH_CONNECT_IN_PROGRESS_SUFFIX,
  SSH_SIGN_IN_AWAITED_SUFFIX,
  SSH_SIGN_IN_CANCELLED_SUFFIX
} from '../../../../shared/ssh-sign-in-required-copy'

function isSignInLine(line: string): boolean {
  return line.endsWith(SSH_SIGN_IN_AWAITED_SUFFIX) || line.endsWith(SSH_SIGN_IN_CANCELLED_SUFFIX)
}

function isConnectInProgressLine(line: string): boolean {
  return line.includes('Connection to ') && line.endsWith(SSH_CONNECT_IN_PROGRESS_SUFFIX)
}

function nonEmptyLines(error: string): string[] {
  return error.split('\n').filter((line) => line.trim().length > 0)
}

/** The host is waiting for the user to sign in: an expected state, not a bug to report. */
export function isSshSignInRequiredTerminalError(error: string): boolean {
  const lines = nonEmptyLines(error)
  return lines.length > 0 && lines.every(isSignInLine)
}

/**
 * Main refused before reaching the host because SSH sign-in has not finished, so the terminal is
 * untouched and the same request succeeds once the user signs in.
 */
export function isSshSignInPendingTerminalError(error: string): boolean {
  const lines = nonEmptyLines(error)
  return (
    lines.length > 0 && lines.every((line) => isSignInLine(line) || isConnectInProgressLine(line))
  )
}

/** Drops Electron's IPC wrapper so the toast reads as the sentence main wrote. */
export function describeSshSignInRequiredTerminalError(error: string): string {
  return error
    .split('\n')
    .map((line) => (isSignInLine(line) ? (compactIpcErrorMessage(line) ?? line) : line))
    .join('\n')
}
