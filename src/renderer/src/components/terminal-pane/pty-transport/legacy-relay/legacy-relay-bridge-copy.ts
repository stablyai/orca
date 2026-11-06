import { translate } from '@/i18n/i18n'

/** Call-time so the language can change after the transport was created. */
export const legacyRelayBridgeUnreachableMessage = (): string =>
  translate(
    'auto.components.terminal.pane.legacyRelayBridge.unreachable',
    'This terminal is still running on the host under an older version of Orca. Reconnecting to it…'
  )
