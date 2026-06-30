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

export type TerminalErrorToastProps = {
  errors: TerminalErrorEntry[]
  onDismiss: () => void
  onRestartDaemon?: () => void
}

export function TerminalErrorToast({
  errors,
  onDismiss,
  onRestartDaemon
}: TerminalErrorToastProps): React.JSX.Element {
  const ssh = errors.some((e) => isSshMessage(e.message))
  const messages = errors.map((e) => e.message)
  const showDaemonRestart = !ssh && onRestartDaemon && shouldOfferDaemonRestart(messages)

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
        background: ssh ? 'rgba(234, 179, 8, 0.12)' : 'rgba(220, 38, 38, 0.15)',
        border: ssh ? '1px solid rgba(234, 179, 8, 0.35)' : '1px solid rgba(220, 38, 38, 0.4)',
        color: ssh ? '#fde68a' : '#fca5a5',
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
                'auto.components.terminal.pane.TerminalErrorToast.cc6d997c65',
                'Restart the terminal daemon from here to clear stale daemon state.'
              )}
            </>
          ) : !ssh ? (
            <>
              {'\n'}
              {translate(
                'auto.components.terminal.pane.TerminalErrorToast.5c8ce20be6',
                'If this persists, please'
              )}{' '}
              <a
                href="https://github.com/stablyai/orca/issues"
                style={{ color: '#fca5a5', textDecoration: 'underline' }}
              >
                {translate(
                  'auto.components.terminal.pane.TerminalErrorToast.a7e2fd2699',
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
              border: '1px solid rgba(252, 165, 165, 0.45)',
              borderRadius: 6,
              background: 'rgba(127, 29, 29, 0.35)',
              color: '#fecaca',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 8px',
              whiteSpace: 'nowrap',
              flexShrink: 0
            }}
          >
            {translate(
              'auto.components.terminal.pane.TerminalErrorToast.e4aa243f8c',
              'Restart daemon'
            )}
          </button>
        ) : null}
        <button
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: ssh ? '#fde68a' : '#fca5a5',
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
}
