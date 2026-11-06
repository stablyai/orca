import {
  readAntigravityChatSignInSnapshot,
  subscribeAntigravityChatSignIns
} from '@/runtime/antigravity-chat-sign-in-status'
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { translate } from '@/i18n/i18n'
import { callAntigravityChatAuthConfig } from '@/runtime/runtime-antigravity-accounts-client'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import { ANTIGRAVITY_CHAT_AUTH_CONFIG_RUNTIME_CAPABILITY } from '../../../../shared/account-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  resolveAntigravityChatAuthConfig,
  type AntigravityChatAuthConfig
} from '../../../../shared/antigravity-chat-auth-config'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

type AuthAction = { disabled: boolean; start: () => void }
type AuthFormProps = {
  owner: RuntimeClientTarget
  disabled: boolean
  onSignIn: () => void
  children: (action: AuthAction) => ReactNode
}

export function AntigravityChatAuthForm({
  owner,
  disabled,
  onSignIn,
  children
}: AuthFormProps): React.JSX.Element | null {
  const capability = useStructuredAgentSessionHostCapabilityState(
    owner,
    ANTIGRAVITY_CHAT_AUTH_CONFIG_RUNTIME_CAPABILITY
  )
  if (capability === 'unsupported') {
    return <>{children({ disabled: false, start: onSignIn })}</>
  }
  const key = owner.kind === 'local' ? 'local' : owner.environmentId
  return (
    <AuthForm
      key={key}
      owner={owner}
      disabled={disabled}
      supported={capability === 'supported'}
      onSignIn={onSignIn}
    >
      {children}
    </AuthForm>
  )
}

function AuthForm({
  owner,
  disabled,
  supported,
  onSignIn,
  children
}: AuthFormProps & { supported: boolean }): React.JSX.Element {
  const id = useId()
  const edited = useRef(false)
  const reads = useRef(0)
  const observation = useSyncExternalStore(subscribeAntigravityChatSignIns, () =>
    readAntigravityChatSignInSnapshot(owner)
  )
  const [loaded, setLoaded] = useState(false)
  const saved = useRef<AntigravityChatAuthConfig | null>(null)
  const mounted = useRef(true)
  const saveInFlight = useRef<{ key: string; result: Promise<boolean> } | null>(null)
  const starting = useRef(false)
  const [preparing, setPreparing] = useState(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [method, setMethod] = useState('oauth-personal')
  const [project, setProject] = useState('')
  const [location, setLocation] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  useEffect(() => {
    if (!supported) {
      return
    }
    let current = true
    const read = reads.current
    const target: RuntimeClientTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    void callAntigravityChatAuthConfig(target).then(
      (config) => {
        if (current && read === reads.current) {
          saved.current = config
          setLoaded(true)
          if (!edited.current) {
            setMethod(config?.method ?? '')
            setProject(config?.gcpProject ?? '')
            setLocation(config?.gcpLocation ?? '')
          }
          setError(
            config
              ? null
              : 'Choose an Antigravity account type and enter its Google Cloud project and location.'
          )
        }
      },
      (cause: unknown) => {
        if (current && read === reads.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Antigravity account settings could not be loaded.'
          )
        }
      }
    )
    return () => {
      current = false
    }
  }, [environmentId, supported, attempt, observation])
  const draft = (nextMethod = method, nextProject = project, nextLocation = location) => ({
    method: nextMethod,
    ...(nextProject ? { gcpProject: nextProject } : {}),
    ...(nextLocation ? { gcpLocation: nextLocation } : {})
  })
  let valid = false
  try {
    resolveAntigravityChatAuthConfig(draft())
    valid = true
  } catch {
    // Incomplete Enterprise fields remain editable without changing the host's saved method.
  }
  const blocked = disabled || pending || preparing || !loaded
  function save(value: unknown): Promise<boolean> {
    let config: AntigravityChatAuthConfig
    try {
      config = resolveAntigravityChatAuthConfig(value)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Enter a Google Cloud project and location.'
      )
      return Promise.resolve(false)
    }
    const key = JSON.stringify(config)
    if (saveInFlight.current) {
      return saveInFlight.current.key === key ? saveInFlight.current.result : Promise.resolve(false)
    }
    setError(null)
    if (key === JSON.stringify(saved.current)) {
      edited.current = false
      return Promise.resolve(true)
    }
    reads.current++
    setPending(true)
    const result = callAntigravityChatAuthConfig(owner, config)
      .then((value) => {
        const next = resolveAntigravityChatAuthConfig(value)
        if (!mounted.current) {
          return false
        }
        reads.current++
        edited.current = false
        saved.current = next
        setMethod(next.method)
        setProject(next.gcpProject ?? '')
        setLocation(next.gcpLocation ?? '')
        return true
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          setError(
            cause instanceof Error
              ? cause.message
              : 'Antigravity account settings could not be saved.'
          )
        }
        return false
      })
      .finally(() => {
        saveInFlight.current = null
        if (mounted.current) {
          setPending(false)
        }
      })
    saveInFlight.current = { key, result }
    return result
  }
  function start(): void {
    if (starting.current || disabled || !loaded) {
      return
    }
    starting.current = true
    setPreparing(true)
    void save(draft())
      .then((success) => {
        if (success && mounted.current) {
          onSignIn()
        }
      })
      .finally(() => {
        starting.current = false
        if (mounted.current) {
          setPreparing(false)
        }
      })
  }
  const commitText = () => void save(draft())
  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }
  return (
    <>
      {children({ disabled: disabled || !loaded || !valid || preparing, start })}
      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-method`} variant="settings">
            {translate('accounts.antigravity.authMethod', 'Sign-in method')}
          </Label>
          <Select
            value={method}
            disabled={blocked}
            onValueChange={(value) => {
              edited.current = true
              setMethod(value)
              void save(draft(value))
            }}
          >
            <SelectTrigger id={`${id}-method`} size="sm" density="compact">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="oauth-personal">
                {translate('accounts.antigravity.personal', 'Google account (personal)')}
              </SelectItem>
              <SelectItem value="oauth-business">
                {translate('accounts.antigravity.enterprise', 'Gemini Enterprise')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {method === 'oauth-business' && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={`${id}-project`} variant="settings">
                {translate('accounts.antigravity.gcpProject', 'Google Cloud project')}
              </Label>
              <Input
                id={`${id}-project`}
                density="compact"
                value={project}
                disabled={blocked}
                placeholder={translate('accounts.antigravity.projectPlaceholder', 'my-project-id')}
                onChange={(event) => {
                  edited.current = true
                  setProject(event.target.value)
                  setError(null)
                }}
                onBlur={commitText}
                onKeyDown={commitOnEnter}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${id}-location`} variant="settings">
                {translate('accounts.antigravity.gcpLocation', 'Google Cloud location')}
              </Label>
              <Input
                id={`${id}-location`}
                density="compact"
                value={location}
                disabled={blocked}
                placeholder={translate('accounts.antigravity.locationPlaceholder', 'us-central1')}
                onChange={(event) => {
                  edited.current = true
                  setLocation(event.target.value)
                  setError(null)
                }}
                onBlur={commitText}
                onKeyDown={commitOnEnter}
              />
            </div>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {translate(
            'accounts.antigravity.authHelp',
            'Changes stop running Antigravity chats. Sign in again to use a different account.'
          )}
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {error && !loaded && (
          <Button size="xs" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
            {translate('common.retry', 'Retry')}
          </Button>
        )}
      </div>
    </>
  )
}
