import { memo } from 'react'
import { translate } from '@/i18n/i18n'
import type { TerminalErrorEntry } from './use-terminal-error-table'

const SSH_PREFIX = 'SSH connection is not active'
const STALE_NODE_PTY_DAEMON_MARKERS = [
  "Daemon's node-pty install is gone",
  'node-pty: posix_spawn failed: ENOENT'
]
const STALE_DAEMON_CWD_MARKERS = [
  "Daemon's working directory is gone",
  'node-pty: daemon_cwd failed: ENOENT'
]

function isSshMessage(message: string): boolean {
  return message.startsWith(SSH_PREFIX)
}

export function shouldOfferDaemonRestart(messages: string[]): boolean {
  const all = messages.join('\n')
  return [STALE_NODE_PTY_DAEMON_MARKERS, STALE_DAEMON_CWD_MARKERS].some((markers) =>
    markers.every((marker) => all.includes(marker))
  )
}

export type TerminalErrorBannerProps = {
  errors: TerminalErrorEntry[]
  onDismiss: () => void
  onRestartDaemon?: () => void
}

// Why: WS flap pushes new array refs to this banner roughly every 100ms. The
// banner is mounted once per workspace and only reads the entries deduped in
// the store, so memoization avoids re-rendering on every push.
export const TerminalErrorBanner = memo(function TerminalErrorBanner({
  errors,
  onDismiss,
  onRestartDaemon
}: TerminalErrorBannerProps): React.JSX.Element {
  const ssh = errors.some((e) => isSshMessage(e.message))
  const messages = errors.map((e) => e.message)
  const showDaemonRestart = !ssh && onRestartDaemon && shouldOfferDaemonRestart(messages)
  // Why: palette tokens (--destructive-soft/border/fg, --color-warning-*) live
  // in src/renderer/src/assets/main.css :root/.dark. They're built off the
  // documented --destructive/--color-warning, so SSH keeps a soft warning tone
  // (yellow) without colliding with destructive.
  const background = ssh ? 'var(--color-warning-soft)' : 'var(--destructive-soft)'
  const borderColor = ssh ? 'var(--color-warning-border)' : 'var(--destructive-border)'
  const foreground = ssh ? 'var(--color-warning-fg)' : 'var(--destructive-fg)'

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 12,
        left: 12,
        right: 12,
        zIndex: 50,
        padding: '10px 14px',
        borderRadius: 6,
        background,
        border: `1px solid ${borderColor}`,
        color: foreground,
        fontSize: 12,
        fontFamily: 'monospace',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'auto'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
        <span style={{ minWidth: 0 }}>
          {errors.map((e, idx) => (
            <div key={e.message}>
              {e.message}
              {e.count > 1 ? ` (×${e.count})` : ''}
              {idx < errors.length - 1 ? '\n' : null}
            </div>
          ))}
          {showDaemonRestart ? (
            <>
              {'\n'}
              {translate(
                'auto.components.terminal.pane.TerminalErrorBanner.cc6d997c65',
                'Restart the terminal daemon from here to clear stale daemon state.'
              )}
            </>
          ) : !ssh ? (
            <>
              {'\n'}
              {translate(
                'auto.components.terminal.pane.TerminalErrorBanner.5c8ce20be6',
                'If this persists, please'
              )}{' '}
              <a
                href="https://github.com/stablyai/orca/issues"
                style={{ color: foreground, textDecoration: 'underline' }}
              >
                {translate(
                  'auto.components.terminal.pane.TerminalErrorBanner.a7e2fd2699',
                  'file an issue'
                )}
              </a>
              .
            </>
          ) : null}
        </span>
        {showDaemonRestart ? (
          <button
            onClick={onRestartDaemon}
            style={{
              marginLeft: 12,
              // Why: bg/border use destructive-soft/border tokens so the action
              // button reads as a destructive secondary control, with a darker
              // base for contrast against the soft banner background.
              border: '1px solid var(--destructive-border)',
              borderRadius: 6,
              background: 'color-mix(in srgb, var(--destructive) 35%, transparent)',
              color: '#fecaca',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 8px',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            {translate(
              'auto.components.terminal.pane.TerminalErrorBanner.e4aa243f8c',
              'Restart daemon'
            )}
          </button>
        ) : null}
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: foreground,
            cursor: 'pointer',
            fontSize: 14,
            padding: '0 0 0 8px',
            lineHeight: 1,
            flexShrink: 0
          }}
        >
          ×
        </button>
      </div>
    </div>
  )
})
