import React from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { LightningIcon } from '@/components/icons/LightningIcon' // We'll just use a generic icon if AiIcon doesn't exist

export function TerminalCommandFailedToast({
  worktreeId,
  exitCode,
  logs,
  onDismiss
}: {
  worktreeId: string
  exitCode: number
  logs: string
  onDismiss: () => void
}): React.JSX.Element {
  const handleAskAi = () => {
    useAppStore.getState().createTab(worktreeId, {
      launchAgent: 'claude',
      initialAgentStatus: {
        agent: 'claude',
        prompt: `The command failed with exit code ${exitCode}. Output:\n\`\`\`\n${logs}\n\`\`\`\n\nPlease help me fix this.`
      }
    })
    onDismiss()
  }

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
        background: 'rgba(220, 38, 38, 0.15)',
        border: '1px solid rgba(220, 38, 38, 0.4)',
        color: '#fca5a5',
        fontSize: 12,
        fontFamily: 'monospace',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'auto'
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ minWidth: 0 }}>
          {translate(
            'auto.components.terminal.pane.TerminalCommandFailedToast.title',
            'Process exited with code {code}',
            { code: exitCode }
          )}
        </span>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            onClick={handleAskAi}
            style={{
              border: '1px solid rgba(252, 165, 165, 0.45)',
              borderRadius: 6,
              background: 'rgba(127, 29, 29, 0.35)',
              color: '#fecaca',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 8px',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 6
            }}
          >
            <LightningIcon style={{ width: 14, height: 14 }} />
            {translate('auto.components.terminal.pane.TerminalCommandFailedToast.askAi', 'Ask AI')}
          </button>
          <button
            onClick={onDismiss}
            style={{
              border: '1px solid rgba(252, 165, 165, 0.45)',
              borderRadius: 6,
              background: 'transparent',
              color: '#fecaca',
              cursor: 'pointer',
              fontSize: 12,
              padding: '4px 8px',
              whiteSpace: 'nowrap'
            }}
          >
            {translate(
              'auto.components.terminal.pane.TerminalCommandFailedToast.dismiss',
              'Dismiss'
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
