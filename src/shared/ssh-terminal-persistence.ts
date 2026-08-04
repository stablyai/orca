export const SSH_TERMINAL_PERSISTENCE_BACKENDS = ['relay', 'zmx'] as const

export type SshTerminalPersistenceBackend = (typeof SSH_TERMINAL_PERSISTENCE_BACKENDS)[number]

export const DEFAULT_SSH_TERMINAL_PERSISTENCE_BACKEND: SshTerminalPersistenceBackend = 'relay'

export function isSshTerminalPersistenceBackend(
  value: unknown
): value is SshTerminalPersistenceBackend {
  return SSH_TERMINAL_PERSISTENCE_BACKENDS.some((backend) => backend === value)
}
