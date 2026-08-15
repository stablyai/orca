import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

export function PlaneApiKeyDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const connectPlane = useAppStore((state) => state.connectPlane)
  const connectPlaneOAuth = useAppStore((state) => state.connectPlaneOAuth)
  const [authMode, setAuthMode] = useState<'apiKey' | 'oauth'>('apiKey')
  const [baseUrl, setBaseUrl] = useState('')
  const [workspaceSlug, setWorkspaceSlug] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [scope, setScope] = useState('read write')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    const result =
      authMode === 'oauth'
        ? await connectPlaneOAuth({ baseUrl, workspaceSlug, clientId, clientSecret, scope })
        : await connectPlane({ baseUrl, workspaceSlug, apiKey })
    setSaving(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    handleOpenChange(false)
  }

  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setApiKey('')
      setClientSecret('')
      setError(null)
    }
    onOpenChange(nextOpen)
  }

  const disabled =
    saving ||
    !baseUrl.trim() ||
    !workspaceSlug.trim() ||
    (authMode === 'oauth' ? !clientId.trim() || !clientSecret.trim() : !apiKey.trim())

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.planeApiKeyDialog.title', 'Add Plane access')}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex gap-2 rounded-lg bg-muted p-1">
            <Button
              type="button"
              size="sm"
              variant={authMode === 'apiKey' ? 'secondary' : 'ghost'}
              onClick={() => setAuthMode('apiKey')}
              className="flex-1"
            >
              {translate('auto.components.planeApiKeyDialog.apiKeyMode', 'API key')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={authMode === 'oauth' ? 'secondary' : 'ghost'}
              onClick={() => setAuthMode('oauth')}
              className="flex-1"
            >
              {translate('auto.components.planeApiKeyDialog.oauthMode', 'OAuth')}
            </Button>
          </div>
          <div className="space-y-2">
            <Label htmlFor="plane-base-url">
              {translate('auto.components.planeApiKeyDialog.baseUrl', 'Base URL')}
            </Label>
            <Input
              id="plane-base-url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://plane.example.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="plane-workspace">
              {translate('auto.components.planeApiKeyDialog.workspaceSlug', 'Workspace slug')}
            </Label>
            <Input
              id="plane-workspace"
              value={workspaceSlug}
              onChange={(event) => setWorkspaceSlug(event.target.value)}
              placeholder="workspace-slug"
            />
          </div>
          {authMode === 'apiKey' ? (
            <div className="space-y-2">
              <Label htmlFor="plane-api-key">
                {translate(
                  'auto.components.planeApiKeyDialog.personalAccessToken',
                  'Personal access token'
                )}
              </Label>
              <Input
                id="plane-api-key"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="plane-client-id">
                  {translate('auto.components.planeApiKeyDialog.clientId', 'OAuth client ID')}
                </Label>
                <Input
                  id="plane-client-id"
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="plane-client-secret">
                  {translate(
                    'auto.components.planeApiKeyDialog.clientSecret',
                    'OAuth client secret'
                  )}
                </Label>
                <Input
                  id="plane-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="plane-scope">
                  {translate('auto.components.planeApiKeyDialog.scope', 'OAuth scopes')}
                </Label>
                <Input
                  id="plane-scope"
                  value={scope}
                  onChange={(event) => setScope(event.target.value)}
                />
              </div>
            </>
          )}
          {error ? <p className="text-sm text-destructive">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={saving}>
            {translate('auto.components.planeApiKeyDialog.cancel', 'Cancel')}
          </Button>
          <Button onClick={() => void submit()} disabled={disabled}>
            {saving
              ? translate('auto.components.planeApiKeyDialog.connecting', 'Connecting...')
              : translate('auto.components.planeApiKeyDialog.connect', 'Connect')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
