import { useState } from 'react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

type TaskSourceRedmineSetupProps = {
  connected: boolean
  checking: boolean
  visible: boolean
  canHide: boolean
  onToggleVisible: () => void
}

export function TaskSourceRedmineSetup({
  connected,
  checking,
  visible,
  canHide,
  onToggleVisible
}: TaskSourceRedmineSetupProps): React.JSX.Element {
  const connectRedmine = useAppStore((s) => s.connectRedmine)
  const testRedmineConnection = useAppStore((s) => s.testRedmineConnection)
  const status = useAppStore((s) => s.redmineStatus)

  const [siteUrl, setSiteUrl] = useState(status.activeSite?.siteUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canConnect = siteUrl.trim().length > 0 && apiKey.trim().length > 0 && !busy

  const handleConnect = async (): Promise<void> => {
    if (!canConnect) {
      return
    }
    setBusy(true)
    setError(null)
    const test = await testRedmineConnection({ siteUrl: siteUrl.trim(), apiKey: apiKey.trim() })
    if (!test.ok) {
      setBusy(false)
      setError(test.error.message)
      return
    }
    const result = await connectRedmine({ siteUrl: siteUrl.trim(), apiKey: apiKey.trim() })
    setBusy(false)
    if (!result.ok) {
      setError(result.error.message)
      return
    }
    setApiKey('')
  }

  return (
    <div className="space-y-4">
      {connected ? (
        <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2.5 text-sm">
          <span className="truncate text-muted-foreground">
            {status.activeSite?.siteUrl ??
              translate('auto.components.settings.TasksPane.redmineConnected', 'Redmine connected')}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canHide}
            onClick={onToggleVisible}
          >
            {visible
              ? translate('auto.components.settings.TasksPane.hideFromTasks', 'Hide from Tasks')
              : translate('auto.components.settings.TasksPane.showInTasks', 'Show in Tasks')}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="redmine-site-url">
              {translate('auto.components.settings.TasksPane.redmineServerUrl', 'Server URL')}
            </Label>
            <Input
              id="redmine-site-url"
              type="text"
              autoComplete="off"
              placeholder="https://redmine.example.com"
              value={siteUrl}
              onChange={(event) => setSiteUrl(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="redmine-api-key">
              {translate('auto.components.settings.TasksPane.redmineApiKey', 'API key')}
            </Label>
            <Input
              id="redmine-api-key"
              type="password"
              autoComplete="off"
              placeholder={translate(
                'auto.components.settings.TasksPane.redmineApiKeyPlaceholder',
                'Paste your Redmine API key'
              )}
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <Button
            type="button"
            size="sm"
            disabled={!canConnect}
            onClick={() => void handleConnect()}
          >
            {checking
              ? translate('auto.components.settings.TasksPane.connecting', 'Connecting…')
              : busy
                ? translate(
                    'auto.components.settings.TasksPane.checkingConnection',
                    'Check & connect…'
                  )
                : translate('auto.components.settings.TasksPane.redmineConnect', 'Connect Redmine')}
          </Button>
        </div>
      )}
    </div>
  )
}
