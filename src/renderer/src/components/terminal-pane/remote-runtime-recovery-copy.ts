import { getIntlLocale, translate } from '@/i18n/i18n'
import type { VisiblePtyRecoveryState } from './terminal-remote-runtime-recovery-ui-state'

/** Why recovery is happening, as far as this client has evidence for it. */
export type RemoteRuntimeRecoveryCause =
  | 'connection-lost'
  | 'server-restarting'
  | 'stream-stalled'
  | 'session-ended'
  | 'waiting-for-server'
  | 'reattaching'

export type RemoteRuntimeRecoveryCopy = { title: string; body: string; retrying: boolean }

export function paneRecoveryCause(
  state: Pick<VisiblePtyRecoveryState, 'cause' | 'waiting'>
): RemoteRuntimeRecoveryCause {
  // Why first: a parked retry has nothing in flight, so no cause may claim it is retrying.
  if (state.waiting) {
    return 'waiting-for-server'
  }
  if (state.cause === 'stream-stalled') {
    return 'stream-stalled'
  }
  if (state.cause === 'stream-ended') {
    return 'session-ended'
  }
  // Why neutral without a cause: claiming a dropped connection needs evidence of one.
  return state.cause === 'connection' ? 'connection-lost' : 'reattaching'
}

export function remoteRuntimeRecoveryCopy(
  cause: RemoteRuntimeRecoveryCause,
  serverName: string
): RemoteRuntimeRecoveryCopy {
  const server = { server: serverName }
  switch (cause) {
    case 'connection-lost':
      return {
        retrying: true,
        title: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.connectionLostTitle',
          'Reconnecting to {{server}}',
          server
        ),
        body: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.connectionLostBody',
          'The connection to the server dropped. Orca is retrying automatically, and terminals resume when it returns.'
        )
      }
    case 'server-restarting':
      return {
        retrying: true,
        title: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.serverRestartingTitle',
          '{{server}} is restarting',
          server
        ),
        body: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.serverRestartingBody',
          'Orca reconnects when the server is back, and terminals resume then.'
        )
      }
    case 'stream-stalled':
      return {
        retrying: true,
        title: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.streamStalledTitle',
          'Terminal stopped responding'
        ),
        body: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.streamStalledBody',
          "{{server}} stopped sending this terminal's output. Orca is reattaching it automatically.",
          server
        )
      }
    case 'session-ended':
      return {
        retrying: true,
        title: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.sessionEndedTitle',
          'Reattaching terminal'
        ),
        body: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.sessionEndedBody',
          "{{server}} closed this terminal's stream. Orca is reattaching it automatically.",
          server
        )
      }
    case 'reattaching':
      return {
        retrying: true,
        title: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.sessionEndedTitle',
          'Reattaching terminal'
        ),
        body: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.reattachingBody',
          'Orca is reattaching this terminal to {{server}} automatically.',
          server
        )
      }
    case 'waiting-for-server':
      return {
        retrying: false,
        title: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.waitingTitle',
          'Waiting for {{server}}',
          server
        ),
        body: translate(
          'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.waitingBody',
          'Orca reattaches this terminal when the server offers it again or the connection changes. Reconnect to try now.'
        )
      }
  }
}

export function remoteRuntimeDownForLabel(downForMs: number): string {
  const seconds = Math.max(0, Math.floor(downForMs / 1000))
  const [value, unit] = seconds < 60 ? [seconds, 'second'] : [Math.floor(seconds / 60), 'minute']
  const duration = new Intl.NumberFormat(getIntlLocale(), {
    style: 'unit',
    unit,
    unitDisplay: 'short'
  }).format(value)
  return translate(
    'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.downFor',
    'Down for {{duration}}',
    { duration }
  )
}

export function remoteRuntimeTailscaleHintLabel(): string {
  return translate(
    'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.tailscaleHint',
    'Check the Tailscale path:'
  )
}

export function fallbackRemoteServerName(): string {
  return translate(
    'auto.components.terminal.pane.TerminalRemoteRuntimeReconnectBanner.fallbackServerName',
    'the server'
  )
}
