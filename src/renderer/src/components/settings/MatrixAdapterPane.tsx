import type React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { SettingsRow, SettingsSwitchRow } from './SettingsFormControls'
import type { MatrixConnectionStatus } from '../../../../shared/matrix-adapter-types'

// Why: status is informational and changes out-of-band (the /sync loop in main
// resolves the viewer after connect). Poll instead of holding a live IPC
// subscription — the pane is only mounted while Settings is open.
const STATUS_POLL_INTERVAL_MS = 4000
const TEST_MESSAGE_BODY = 'Orca test'

type TestState = { kind: 'idle' } | { kind: 'ok' } | { kind: 'error'; message: string }

export function MatrixAdapterPane(): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const [token, setToken] = useState('')
  const [status, setStatus] = useState<MatrixConnectionStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [testState, setTestState] = useState<TestState>({ kind: 'idle' })

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await window.api.matrix.status())
    } catch {
      // Why: a status read failing is non-fatal — leave the last-known status
      // rather than blanking the pane on a transient IPC hiccup.
    }
  }, [])

  // Poll status while the pane is mounted so connect/disconnect outcomes and the
  // lazily-resolved viewer surface without manual refresh.
  useEffect(() => {
    void refreshStatus()
    const timer = setInterval(() => {
      void refreshStatus()
    }, STATUS_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refreshStatus])

  if (!settings) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate('matrix.settings.loading', 'Loading settings…')}
      </p>
    )
  }

  const matrixEnabled = settings.matrixEnabled ?? false
  const forwardSystem = settings.matrixForwardSystemMessages ?? false
  const forwardAgentStatus = settings.matrixForwardAgentStatus ?? false
  const forwardErrors = settings.matrixForwardErrors ?? false

  const handleConnect = async (): Promise<void> => {
    if (!token.trim() || busy) {
      return
    }
    setBusy(true)
    setConnectError(null)
    try {
      const result = await window.api.matrix.connect({ token: token.trim() })
      if (result.ok) {
        setToken('')
      } else {
        setConnectError(
          result.error ?? translate('matrix.settings.connect_failed', 'Connect failed')
        )
      }
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
      void refreshStatus()
    }
  }

  const handleDisconnect = async (): Promise<void> => {
    if (busy) {
      return
    }
    setBusy(true)
    setConnectError(null)
    try {
      await window.api.matrix.disconnect()
    } finally {
      setBusy(false)
      void refreshStatus()
    }
  }

  const handleSendTest = async (): Promise<void> => {
    setTestState({ kind: 'idle' })
    try {
      const result = await window.api.matrix.sendTest({ message: TEST_MESSAGE_BODY })
      setTestState(result.ok ? { kind: 'ok' } : { kind: 'error', message: result.error })
    } catch (error) {
      setTestState({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const connectedLabel =
    status?.running && status.viewer
      ? translate('matrix.settings.connected_as', 'Connected as {{value0}}', {
          value0: status.viewer.userId
        })
      : status?.running
        ? translate('matrix.settings.connected', 'Connected')
        : translate('matrix.settings.disconnected', 'Not connected')

  return (
    <div className="space-y-4">
      <SettingsSwitchRow
        label={translate('matrix.settings.enable_label', 'Enable Matrix adapter')}
        description={translate(
          'matrix.settings.enable_desc',
          'Connect Orca to a Matrix room to forward messages and route replies back to sessions.'
        )}
        checked={matrixEnabled}
        onChange={() => updateSettings({ matrixEnabled: !matrixEnabled })}
      />

      <SettingsRow
        label={translate('matrix.settings.homeserver_label', 'Homeserver')}
        description={translate(
          'matrix.settings.homeserver_desc',
          'Base URL of the Matrix homeserver.'
        )}
        control={
          <Input
            value={settings.matrixHomeserver ?? ''}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder={translate('matrix.settings.homeserver_ph', 'https://matrix.example.org')}
            onChange={(e) => updateSettings({ matrixHomeserver: e.target.value })}
            className="w-72"
          />
        }
      />

      <SettingsRow
        label={translate('matrix.settings.user_label', 'User ID')}
        description={translate('matrix.settings.user_desc', 'The Matrix account Orca posts as.')}
        control={
          <Input
            value={settings.matrixUserId ?? ''}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder={translate('matrix.settings.user_ph', '@orca:example.org')}
            onChange={(e) => updateSettings({ matrixUserId: e.target.value })}
            className="w-72"
          />
        }
      />

      <SettingsRow
        label={translate('matrix.settings.room_label', 'Room ID')}
        description={translate(
          'matrix.settings.room_desc',
          'The room messages are forwarded to and read from.'
        )}
        control={
          <Input
            value={settings.matrixRoomId ?? ''}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            placeholder={translate('matrix.settings.room_ph', '!roomid:example.org')}
            onChange={(e) => updateSettings({ matrixRoomId: e.target.value })}
            className="w-72"
          />
        }
      />

      <SettingsRow
        label={translate('matrix.settings.token_label', 'Access token')}
        description={connectedLabel}
        alignTop
        control={
          <div className="flex flex-col items-end gap-2">
            <Input
              type="password"
              value={token}
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              placeholder={translate('matrix.settings.token_ph', 'syt_…')}
              onChange={(e) => setToken(e.target.value)}
              className="w-72"
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => void handleConnect()}
                disabled={busy || !token.trim()}
              >
                {translate('matrix.settings.connect', 'Connect')}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleDisconnect()}
                disabled={busy}
              >
                {translate('matrix.settings.disconnect', 'Disconnect')}
              </Button>
            </div>
            {connectError ? (
              <p className="text-xs text-destructive">{connectError}</p>
            ) : status?.error ? (
              <p className="text-xs text-destructive">{status.error}</p>
            ) : null}
          </div>
        }
      />

      <SettingsRow
        label={translate('matrix.settings.test_label', 'Send test message')}
        description={translate(
          'matrix.settings.test_desc',
          'Post a test message to the configured room to verify the connection.'
        )}
        alignTop
        control={
          <div className="flex flex-col items-end gap-2">
            <Button size="sm" variant="outline" onClick={() => void handleSendTest()}>
              {translate('matrix.settings.test_button', 'Send test')}
            </Button>
            {testState.kind === 'ok' ? (
              <p className="text-xs text-muted-foreground">
                {translate('matrix.settings.test_ok', 'Test message sent.')}
              </p>
            ) : testState.kind === 'error' ? (
              <p className="text-xs text-destructive">{testState.message}</p>
            ) : null}
          </div>
        }
      />

      <SettingsSwitchRow
        label={translate('matrix.settings.forward_system_label', 'Forward system messages')}
        description={translate(
          'matrix.settings.forward_system_desc',
          'Send Orca system events (agent status, errors) to the Matrix room.'
        )}
        checked={forwardSystem}
        onChange={() => updateSettings({ matrixForwardSystemMessages: !forwardSystem })}
      />

      {forwardSystem ? (
        <>
          <SettingsSwitchRow
            label={translate('matrix.settings.forward_agent_status_label', 'Forward agent status')}
            description={translate(
              'matrix.settings.forward_agent_status_desc',
              'Include working / blocked / waiting / done status changes.'
            )}
            checked={forwardAgentStatus}
            onChange={() => updateSettings({ matrixForwardAgentStatus: !forwardAgentStatus })}
          />
          <SettingsSwitchRow
            label={translate('matrix.settings.forward_errors_label', 'Forward errors')}
            description={translate(
              'matrix.settings.forward_errors_desc',
              'Include agent and session error events.'
            )}
            checked={forwardErrors}
            onChange={() => updateSettings({ matrixForwardErrors: !forwardErrors })}
          />
        </>
      ) : null}
    </div>
  )
}
