import { useState } from 'react'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { SentryConnectionStatus } from '../../../shared/sentry-types'
import { sentryConnect, sentrySelectOrganization } from '@/runtime/runtime-sentry-client'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'

export function SentryConnectDialog({
  open,
  onOpenChange,
  settings,
  onConnected
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  onConnected: (status: SentryConnectionStatus) => void
}): React.JSX.Element {
  const [baseUrl, setBaseUrl] = useState('https://sentry.io')
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<SentryConnectionStatus | null>(null)
  const [organizationSlug, setOrganizationSlug] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const changeOpen = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setToken('')
      setStatus(null)
      setOrganizationSlug('')
      setError(null)
    }
    onOpenChange(nextOpen)
  }

  const connect = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const result = await sentryConnect(settings, { baseUrl, token })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setStatus(result.status)
      setOrganizationSlug(result.status.connection?.organization.slug ?? '')
      if (result.status.organizations.length === 1) {
        onConnected(result.status)
        changeOpen(false)
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : translate(
              'auto.components.sentry.connect.dialog.connectFailed',
              'Could not connect to Sentry.'
            )
      )
    } finally {
      setSaving(false)
    }
  }

  const finish = async (): Promise<void> => {
    if (!organizationSlug) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      const next = await sentrySelectOrganization(settings, organizationSlug)
      onConnected(next)
      changeOpen(false)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : translate(
              'auto.components.sentry.connect.dialog.organizationFailed',
              'Could not select the organization.'
            )
      )
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{translate("auto.components.sentry.connect.dialog.95856ffe39", "Connect Sentry")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          {!status ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="sentry-base-url">{translate("auto.components.sentry.connect.dialog.5968e4b379", "Base URL")}</Label>
                <Input
                  id="sentry-base-url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sentry-auth-token">{translate("auto.components.sentry.connect.dialog.4790ee6d53", "Auth token")}</Label>
                <Input
                  id="sentry-auth-token"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  {translate("auto.components.sentry.connect.dialog.7471c5d890", "Use a token with event:read. Triage also needs event:write or event:admin.")}</p>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label>{translate("auto.components.sentry.connect.dialog.4c04d2f996", "Organization")}</Label>
              <Select value={organizationSlug} onValueChange={setOrganizationSlug}>
                <SelectTrigger>
                  <SelectValue placeholder={translate("auto.components.sentry.connect.dialog.5a5acff1a4", "Select an organization")} />
                </SelectTrigger>
                <SelectContent>
                  {status.organizations.map((organization) => (
                    <SelectItem key={organization.id} value={organization.slug}>
                      {organization.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => changeOpen(false)}>
            {translate("auto.components.sentry.connect.dialog.112c98c590", "Cancel")}</Button>
          <Button
            disabled={
              saving ||
              (!status && (!baseUrl.trim() || !token.trim())) ||
              (Boolean(status) && !organizationSlug)
            }
            onClick={() => void (status ? finish() : connect())}
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {status ? translate("auto.components.sentry.connect.dialog.aaf36ea058", "Use organization") : translate("auto.components.sentry.connect.dialog.e6ab4ce1a8", "Connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
