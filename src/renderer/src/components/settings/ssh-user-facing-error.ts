import { translate } from '@/i18n/i18n'

const ELECTRON_IPC_PREFIX = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i

const KNOWN_SSH_ERRORS: { test: RegExp; key: string; fallback: string }[] = [
  {
    test: /connection lost before handshake/i,
    key: 'settings.ssh.errors.handshakeLost',
    fallback: 'Connection lost before handshake'
  },
  {
    test: /cannot parse privateKey:.*bad passphrase/i,
    key: 'settings.ssh.errors.badPassphrase',
    fallback: 'Cannot parse privateKey: OpenSSH key integrity check failed -- bad passphrase?'
  },
  {
    test: /all configured authentication methods failed/i,
    key: 'settings.ssh.errors.authMethodsFailed',
    fallback: 'All configured authentication methods failed'
  },
  {
    test: /timed out while waiting for handshake/i,
    key: 'settings.ssh.errors.handshakeTimeout',
    fallback: 'Timed out while waiting for handshake'
  },
  {
    test: /host key verification failed/i,
    key: 'settings.ssh.errors.hostKeyVerificationFailed',
    fallback: 'Host key verification failed'
  },
  {
    test: /permission denied \(publickey\)/i,
    key: 'settings.ssh.errors.permissionDeniedPublickey',
    fallback: 'Permission denied (publickey)'
  },
  {
    test: /permission denied/i,
    key: 'settings.ssh.errors.permissionDenied',
    fallback: 'Permission denied'
  },
  {
    test: /getaddrinfo ENOTFOUND/i,
    key: 'settings.ssh.errors.hostNotFound',
    fallback: 'Host not found'
  },
  {
    test: /connect ECONNREFUSED/i,
    key: 'settings.ssh.errors.connectionRefused',
    fallback: 'Connection refused'
  },
  {
    test: /connect ETIMEDOUT|connect EHOSTUNREACH/i,
    key: 'settings.ssh.errors.connectionTimedOut',
    fallback: 'Connection timed out'
  }
]

export function stripElectronIpcErrorPrefix(raw: string): string {
  return raw.replace(ELECTRON_IPC_PREFIX, '').trim()
}

export function formatSshUserFacingError(raw: string | null | undefined): string {
  if (!raw?.trim()) {
    return translate('auto.components.settings.SshPane.e95d5ae10e', 'Connection failed')
  }
  const message = stripElectronIpcErrorPrefix(raw)
  for (const known of KNOWN_SSH_ERRORS) {
    if (known.test.test(message)) {
      return translate(known.key, known.fallback)
    }
  }
  return message
}

export function formatSshErrorOrFallback(error: unknown, fallback: string): string {
  return error instanceof Error ? formatSshUserFacingError(error.message) : fallback
}
