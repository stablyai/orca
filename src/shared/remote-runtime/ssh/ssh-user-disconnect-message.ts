const SSH_USER_DISCONNECTED_SUFFIX = 'was disconnected. Connect to use it again.'

export function formatSshUserDisconnectedMessage(label: string): string {
  return `${label} ${SSH_USER_DISCONNECTED_SUFFIX}`
}

/** IPC drops Error.code, so renderers recognize the held-disconnected refusal by its message. */
export function isSshUserDisconnectedMessage(message: string): boolean {
  return message.endsWith(SSH_USER_DISCONNECTED_SUFFIX)
}
