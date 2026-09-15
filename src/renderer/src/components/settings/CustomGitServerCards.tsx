import { useMemo, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  GitPullRequestArrow,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useMountedRef } from '@/hooks/useMountedRef'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { useAppStore } from '@/store'
import {
  CUSTOM_GIT_SERVER_API_FLAVORS,
  DEFAULT_CUSTOM_GIT_SERVER_API_FLAVOR,
  type CustomGitServerApiFlavor,
  type CustomGitServerStatus
} from '../../../../shared/custom-git-server'
import { IntegrationCardDetails, IntegrationCardShell } from './integration-card-shell'
import { translate } from '@/i18n/i18n'

const API_FLAVOR_LABELS: Record<CustomGitServerApiFlavor, string> = {
  gitlab: 'GitLab (v4)'
}

type FormState = {
  id?: string
  name: string
  host: string
  apiBaseUrl: string
  apiFlavor: CustomGitServerApiFlavor
  token: string
}

type TestResult = { state: 'ok'; account: string | null } | { state: 'error'; error: string }

function emptyForm(): FormState {
  return {
    name: '',
    host: '',
    apiBaseUrl: '',
    apiFlavor: DEFAULT_CUSTOM_GIT_SERVER_API_FLAVOR,
    token: ''
  }
}

function formFromServer(server: CustomGitServerStatus): FormState {
  return {
    id: server.id,
    name: server.name,
    host: server.host,
    apiBaseUrl: server.apiBaseUrl,
    apiFlavor: server.apiFlavor,
    token: ''
  }
}

function CustomGitServerForm(props: {
  initial: FormState
  onDone: () => void
}): React.JSX.Element {
  const saveCustomGitServer = useAppStore((s) => s.saveCustomGitServer)
  const testCustomGitServer = useAppStore((s) => s.testCustomGitServer)
  const mountedRef = useMountedRef()
  const [form, setForm] = useState<FormState>(props.initial)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [busy, setBusy] = useState<'test' | 'save' | null>(null)
  const editing = props.initial.id !== undefined

  const canSubmit =
    form.name.trim().length > 0 &&
    form.host.trim().length > 0 &&
    form.apiBaseUrl.trim().length > 0 &&
    // A token is required to create; editing may keep the existing one.
    (editing || form.token.trim().length > 0)

  const update = (patch: Partial<FormState>): void => {
    setForm((prev) => ({ ...prev, ...patch }))
    setTestResult(null)
  }

  const handleTest = async (): Promise<void> => {
    setBusy('test')
    setTestResult(null)
    // Why: a rejected IPC call must still clear the busy state and report an error.
    let next: TestResult
    try {
      const result = await testCustomGitServer({ ...form, token: form.token.trim() })
      next = result.ok
        ? { state: 'ok', account: result.account }
        : { state: 'error', error: result.error }
    } catch (error) {
      next = { state: 'error', error: error instanceof Error ? error.message : String(error) }
    }
    if (mountedRef.current) {
      setTestResult(next)
      setBusy(null)
    }
  }

  const handleSave = async (): Promise<void> => {
    setBusy('save')
    try {
      await saveCustomGitServer({
        ...(form.id ? { id: form.id } : {}),
        name: form.name.trim(),
        host: form.host.trim(),
        apiBaseUrl: form.apiBaseUrl.trim(),
        apiFlavor: form.apiFlavor,
        // Blank token on edit keeps the stored one.
        ...(form.token.trim() ? { token: form.token.trim() } : {})
      })
      if (mountedRef.current) {
        props.onDone()
      }
    } catch (error) {
      if (mountedRef.current) {
        setTestResult({ state: 'error', error: error instanceof Error ? error.message : String(error) })
        setBusy(null)
      }
    }
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="cgs-name">
            {translate('settings.customGitServer.field.name', 'Name')}
          </Label>
          <Input
            id="cgs-name"
            value={form.name}
            placeholder={translate('settings.customGitServer.placeholder.name', 'My Git Server')}
            onChange={(event) => update({ name: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cgs-host">
            {translate('settings.customGitServer.field.host', 'Host')}
          </Label>
          <Input
            id="cgs-host"
            value={form.host}
            placeholder={translate('settings.customGitServer.placeholder.host', 'git.example.com')}
            onChange={(event) => update({ host: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cgs-base">
            {translate('settings.customGitServer.field.apiBaseUrl', 'API base URL')}
          </Label>
          <Input
            id="cgs-base"
            value={form.apiBaseUrl}
            placeholder={translate(
              'settings.customGitServer.placeholder.apiBaseUrl',
              'https://git.example.com'
            )}
            onChange={(event) => update({ apiBaseUrl: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="cgs-flavor">
            {translate('settings.customGitServer.field.apiType', 'API type')}
          </Label>
          <Select
            value={form.apiFlavor}
            onValueChange={(value) => update({ apiFlavor: value as CustomGitServerApiFlavor })}
          >
            <SelectTrigger id="cgs-flavor" size="sm" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CUSTOM_GIT_SERVER_API_FLAVORS.map((flavor) => (
                <SelectItem key={flavor} value={flavor}>
                  {API_FLAVOR_LABELS[flavor]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="cgs-token">
          {translate('settings.customGitServer.field.token', 'Token')}
        </Label>
        <Input
          id="cgs-token"
          type="password"
          value={form.token}
          placeholder={
            editing
              ? translate('settings.customGitServer.token.keep', 'Leave blank to keep existing token')
              : translate('settings.customGitServer.token.new', 'Personal access token')
          }
          onChange={(event) => update({ token: event.target.value })}
        />
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'settings.customGitServer.token.help',
            'Stored locally and encrypted when your OS keychain is available.'
          )}
        </p>
      </div>
      {testResult ? (
        <p
          className={
            testResult.state === 'ok'
              ? 'flex items-center gap-1.5 text-xs text-status-success'
              : 'flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300'
          }
        >
          {testResult.state === 'ok' ? (
            <>
              <CheckCircle2 className="size-3.5" />
              {testResult.account
                ? translate('settings.customGitServer.test.okAccount', 'Connected as {{value0}}', {
                    value0: testResult.account
                  })
                : translate('settings.customGitServer.test.ok', 'Connection succeeded')}
            </>
          ) : (
            <>
              <AlertCircle className="size-3.5" />
              {testResult.error}
            </>
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={!canSubmit || busy !== null}>
          {busy === 'save' ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {translate('settings.customGitServer.action.save', 'Save')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={
            busy !== null ||
            !form.host.trim() ||
            !form.apiBaseUrl.trim() ||
            !form.token.trim()
          }
        >
          {busy === 'test' ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {translate('settings.customGitServer.action.test', 'Test connection')}
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onDone} disabled={busy !== null}>
          {translate('settings.customGitServer.action.cancel', 'Cancel')}
        </Button>
      </div>
    </div>
  )
}

function CustomGitServerRow(props: {
  server: CustomGitServerStatus
  onEdit: () => void
}): React.JSX.Element {
  const removeCustomGitServer = useAppStore((s) => s.removeCustomGitServer)
  const mountedRef = useMountedRef()
  const [removing, setRemoving] = useState(false)
  const connected = props.server.authenticated
  const statusLabel = connected
    ? 'Connected'
    : props.server.configured
      ? 'Auth failed'
      : 'Not configured'
  const accountSuffix = connected && props.server.account ? ` · ${props.server.account}` : ''

  const handleRemove = async (): Promise<void> => {
    setRemoving(true)
    try {
      await removeCustomGitServer(props.server.id)
    } catch (error) {
      // Why: reset on failure so the Remove button isn't stuck if the IPC rejects.
      if (mountedRef.current) {
        setRemoving(false)
      }
      toast.error(
        translate('settings.customGitServer.error.remove', 'Failed to remove server'),
        { description: error instanceof Error ? error.message : String(error) }
      )
    }
  }

  return (
    <IntegrationCardShell
      icon={<GitPullRequestArrow className="size-5" />}
      name={props.server.name}
      description={`${props.server.host}${accountSuffix} · ${API_FLAVOR_LABELS[props.server.apiFlavor]}`}
      statusTone={connected ? 'connected' : 'attention'}
      statusLabel={statusLabel}
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={props.onEdit}>
            <Pencil className="size-3.5" />
            {translate('settings.customGitServer.action.edit', 'Edit')}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleRemove} disabled={removing}>
            {removing ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            {translate('settings.customGitServer.action.remove', 'Remove')}
          </Button>
        </>
      }
    />
  )
}

export function CustomGitServerSection(): React.JSX.Element {
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const expectedContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const [editing, setEditing] = useState<FormState | null>(null)

  const current = preflightStatusContextKey === expectedContextKey
  const checking = preflightStatusLoading || !preflightStatusChecked || !current
  const servers = useMemo<CustomGitServerStatus[]>(
    () => (current ? (preflightStatus?.customGitServers ?? []) : []),
    [current, preflightStatus]
  )

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-foreground">
            {translate('settings.customGitServer.title', 'Custom git servers')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'settings.customGitServer.description',
              'Add self-hosted or internal git servers (e.g. git.example.com) for pull/merge requests and review status.'
            )}
          </p>
        </div>
        {editing === null ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(emptyForm())}>
            <Plus className="size-3.5" />
            {translate('settings.customGitServer.action.add', 'Add custom git server')}
          </Button>
        ) : null}
      </div>

      {editing !== null && editing.id === undefined ? (
        <IntegrationCardShell
          icon={<GitPullRequestArrow className="size-5" />}
          name={translate('settings.customGitServer.add', 'Add custom git server')}
          description={translate(
            'settings.customGitServer.addHint',
            'Enter the server host, API base URL, and a token.'
          )}
          statusTone="neutral"
          statusLabel="New"
        >
          <IntegrationCardDetails>
            <CustomGitServerForm initial={editing} onDone={() => setEditing(null)} />
          </IntegrationCardDetails>
        </IntegrationCardShell>
      ) : null}

      {checking && servers.length === 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" />
          {translate('settings.customGitServer.checking', 'Checking configured servers…')}
        </p>
      ) : null}

      <div className="space-y-3">
        {servers.map((server) =>
          editing?.id === server.id ? (
            <IntegrationCardShell
              key={server.id}
              icon={<GitPullRequestArrow className="size-5" />}
              name={translate('settings.customGitServer.edit', 'Edit {{value0}}', {
                value0: server.name
              })}
              description={server.host}
              statusTone="neutral"
              statusLabel="Editing"
            >
              <IntegrationCardDetails>
                <CustomGitServerForm initial={editing} onDone={() => setEditing(null)} />
              </IntegrationCardDetails>
            </IntegrationCardShell>
          ) : (
            <CustomGitServerRow
              key={server.id}
              server={server}
              onEdit={() => setEditing(formFromServer(server))}
            />
          )
        )}
      </div>
    </section>
  )
}
