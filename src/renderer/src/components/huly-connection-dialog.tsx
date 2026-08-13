import { useId, useState } from 'react'
import { Eye, EyeOff, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { hasRemoteProviderRuntime } from '@/lib/provider-runtime-context'

type HulyConnectionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  overlayClassName?: string
  contentClassName?: string
}

type AuthMode = 'token' | 'password'

type DialogState = {
  name: string
  url: string
  workspace: string
  email: string
  secret: string
  mode: AuthMode
  showSecret: boolean
  connectState: 'idle' | 'connecting' | 'error'
  connectError: string
}

function initialState(): DialogState {
  return {
    name: '',
    url: 'https://huly.app',
    workspace: '',
    email: '',
    secret: '',
    mode: 'token',
    showSecret: false,
    connectState: 'idle',
    connectError: ''
  }
}

export function HulyConnectionDialog({
  open,
  onOpenChange,
  overlayClassName,
  contentClassName
}: HulyConnectionDialogProps): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const connectHuly = useAppStore((s) => s.connectHuly)
  const mountedRef = useMountedRef()

  const nameId = useId()
  const urlId = useId()
  const workspaceId = useId()
  const emailId = useId()
  const secretId = useId()

  const [state, setState] = useState<DialogState>(initialState)
  const isRemote = hasRemoteProviderRuntime(settings)

  // Why: parent-controlled close can race an in-flight connect request.
  if (!open && (state.connectState !== 'idle' || state.connectError || state.secret)) {
    if (state.connectState !== 'connecting') {
      setState(initialState())
    }
  }

  const handleOpenChange = (next: boolean): void => {
    if (state.connectState === 'connecting') {
      return
    }
    if (!next) {
      setState(initialState())
    }
    onOpenChange(next)
  }

  const handleConnect = async (): Promise<void> => {
    if (state.connectState === 'connecting') {
      return
    }
    if (
      !state.name.trim() ||
      !state.url.trim() ||
      !state.workspace.trim() ||
      !state.secret.trim()
    ) {
      setState((s) => ({
        ...s,
        connectState: 'error',
        connectError: translate(
          'auto.components.huly.connection.dialog.required_fields_missing',
          'Connection name, base URL, workspace, and credential are required.'
        )
      }))
      return
    }
    setState((s) => ({ ...s, connectState: 'connecting', connectError: '' }))
    const result = await connectHuly({
      name: state.name.trim(),
      url: state.url.trim(),
      workspace: state.workspace.trim(),
      email: state.email.trim() || null,
      secret: state.secret.trim(),
      token: state.mode === 'token' ? state.secret.trim() : null
    })
    if (!mountedRef.current) {
      return
    }
    if (result.ok) {
      setState(initialState())
      onOpenChange(false)
    } else {
      setState((s) => ({ ...s, connectState: 'error', connectError: result.error }))
    }
  }

  const serverLabel = isRemote
    ? translate('auto.components.huly.connection.dialog.server_remote', 'the Orca server')
    : translate('auto.components.huly.connection.dialog.server_local', 'this machine')
  const secretLabel =
    state.mode === 'token'
      ? translate('auto.components.huly.connection.dialog.secret_token', 'Personal access token')
      : translate('auto.components.huly.connection.dialog.secret_password', 'Password')

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent overlayClassName={overlayClassName} className={contentClassName}>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.huly.connection.dialog.title', 'Connect a Huly instance')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.huly.connection.dialog.description',
              'Orca stores the credential in its encrypted keychain on {{value0}} and shells out to the `huly` CLI to talk to Huly.',
              { value0: serverLabel }
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1">
            <Label htmlFor={nameId}>
              {translate('auto.components.huly.connection.dialog.name', 'Connection name')}
            </Label>
            <Input
              id={nameId}
              value={state.name}
              onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
              placeholder={translate(
                'auto.components.huly.connection.dialog.name_placeholder',
                'My Huly workspace'
              )}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={urlId}>
              {translate('auto.components.huly.connection.dialog.url', 'Huly base URL')}
            </Label>
            <Input
              id={urlId}
              value={state.url}
              onChange={(e) => setState((s) => ({ ...s, url: e.target.value }))}
              placeholder="https://huly.app"
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={workspaceId}>
              {translate('auto.components.huly.connection.dialog.workspace', 'Workspace name')}
            </Label>
            <Input
              id={workspaceId}
              value={state.workspace}
              onChange={(e) => setState((s) => ({ ...s, workspace: e.target.value }))}
              placeholder={translate(
                'auto.components.huly.connection.dialog.workspace_placeholder',
                'my-workspace'
              )}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={emailId}>
              {translate(
                'auto.components.huly.connection.dialog.email',
                'Email (optional, for password auth)'
              )}
            </Label>
            <Input
              id={emailId}
              type="email"
              value={state.email}
              onChange={(e) => setState((s) => ({ ...s, email: e.target.value }))}
              placeholder={translate(
                'auto.components.huly.connection.dialog.email_placeholder',
                'you@example.com'
              )}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={secretId}>{secretLabel}</Label>
            <div className="relative">
              <Input
                id={secretId}
                type={state.showSecret ? 'text' : 'password'}
                value={state.secret}
                onChange={(e) => setState((s) => ({ ...s, secret: e.target.value }))}
                placeholder={
                  state.mode === 'token'
                    ? translate(
                        'auto.components.huly.connection.dialog.token_placeholder',
                        'huly_pat_...'
                      )
                    : translate(
                        'auto.components.huly.connection.dialog.password_placeholder',
                        'password'
                      )
                }
                autoComplete="off"
              />
              <button
                type="button"
                onClick={() => setState((s) => ({ ...s, showSecret: !s.showSecret }))}
                aria-label={
                  state.showSecret
                    ? translate('auto.components.huly.connection.dialog.hide_secret', 'Hide secret')
                    : translate('auto.components.huly.connection.dialog.show_secret', 'Show secret')
                }
                className="absolute inset-y-0 right-2 flex items-center text-muted-foreground hover:text-foreground"
              >
                {state.showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() =>
                  setState((s) => ({ ...s, mode: s.mode === 'token' ? 'password' : 'token' }))
                }
                className="underline hover:text-foreground"
              >
                {state.mode === 'token'
                  ? translate(
                      'auto.components.huly.connection.dialog.use_password',
                      'Use password instead'
                    )
                  : translate(
                      'auto.components.huly.connection.dialog.use_token',
                      'Use access token instead'
                    )}
              </button>
            </div>
          </div>
          {state.connectState === 'error' && state.connectError ? (
            <p className="text-xs text-destructive" role="alert">
              {state.connectError}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={state.connectState === 'connecting'}
          >
            {translate('auto.components.huly.connection.dialog.cancel', 'Cancel')}
          </Button>
          <Button
            onClick={() => void handleConnect()}
            disabled={state.connectState === 'connecting'}
          >
            {state.connectState === 'connecting' ? (
              <>
                <LoaderCircle className="size-3.5 mr-1.5 animate-spin" />
                {translate('auto.components.huly.connection.dialog.connecting', 'Connecting...')}
              </>
            ) : (
              translate('auto.components.huly.connection.dialog.connect', 'Connect')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
