/** Refusal code for a connect nobody clicked, against a host the user disconnected. */
export const SSH_DISCONNECTED_BY_USER_CODE = 'ssh_disconnected_by_user'

export function describeSshDisconnectedByUser(hostLabel: string): string {
  return `${hostLabel} was disconnected on the desktop. Connect it again to continue.`
}

export function createSshDisconnectedByUserError(hostLabel: string): Error & { code: string } {
  return Object.assign(new Error(describeSshDisconnectedByUser(hostLabel)), {
    code: SSH_DISCONNECTED_BY_USER_CODE
  })
}

export function isSshDisconnectedByUserError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === SSH_DISCONNECTED_BY_USER_CODE
}
