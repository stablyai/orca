export const SSH_TERMINAL_PERSISTENCE_BACKENDS = ['relay', 'zmx'] as const

export type SshTerminalPersistenceBackend = (typeof SSH_TERMINAL_PERSISTENCE_BACKENDS)[number]

// Why: zmx is opt-in per target — it requires the zmx binary on the remote host.
export const DEFAULT_SSH_TERMINAL_PERSISTENCE_BACKEND: SshTerminalPersistenceBackend = 'relay'

export function resolveSshTerminalPersistenceBackend(
  backend: SshTerminalPersistenceBackend | null | undefined
): SshTerminalPersistenceBackend {
  return backend ?? DEFAULT_SSH_TERMINAL_PERSISTENCE_BACKEND
}

export function isSshTerminalPersistenceBackend(
  value: unknown
): value is SshTerminalPersistenceBackend {
  return SSH_TERMINAL_PERSISTENCE_BACKENDS.some((backend) => backend === value)
}
