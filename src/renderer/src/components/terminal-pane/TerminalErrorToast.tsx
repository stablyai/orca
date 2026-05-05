const SSH_PREFIX = 'SSH connection is not active'

function isSshError(error: string): boolean {
  return error.startsWith(SSH_PREFIX)
}

export function TerminalErrorToast({
  error,
  onDismiss
}: {
  error: string
  onDismiss: () => void
}): React.JSX.Element {
  const ssh = isSshError(error)

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
        <span>
          {error}
          {!ssh && (
            <>
              {'\n'}
              If this persists, please{' '}
              <a
                href="https://github.com/stablyai/orca/issues"
                style={{ color: '#fca5a5', textDecoration: 'underline' }}
              >
                file an issue
              </a>
              .
            </>
          )}
        </span>
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
