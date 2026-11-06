import {
  antigravityChatSignInRunning,
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
  isAntigravityChatAuthUnconfirmed,
  resolveAntigravityChatAuthConfig,
  type AntigravityChatAuthConfig
} from '../../../../shared/antigravity-chat-auth-config'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

type AuthAction = {
  disabled: boolean
  start: () => void
  hint: string | null
  reauth: boolean
  alert: string | null
}
type AuthFormProps = {
  owner: RuntimeClientTarget
  disabled: boolean
  onSignIn: () => void
  heading: ReactNode
  hostLabel: string
  signInError?: string | null
  children: (action: AuthAction) => ReactNode
}

export function AntigravityChatAuthForm({
  owner,
  disabled,
  onSignIn,
  heading,
  hostLabel,
  signInError,
  children
}: AuthFormProps): React.JSX.Element | null {
  const capability = useStructuredAgentSessionHostCapabilityState(
    owner,
    ANTIGRAVITY_CHAT_AUTH_CONFIG_RUNTIME_CAPABILITY
  )
  if (capability === 'unsupported') {
    return (
      <>
        {heading}
        {children({
          disabled: false,
          start: onSignIn,
          hint: null,
          reauth: false,
          alert: signInError ?? null
        })}
      </>
    )
  }
  const key = owner.kind === 'local' ? 'local' : owner.environmentId
  return (
    <AuthForm
      key={key}
      owner={owner}
      disabled={disabled}
      supported={capability === 'supported'}
      onSignIn={onSignIn}
      heading={heading}
      hostLabel={hostLabel}
      signInError={signInError}
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
  heading,
  hostLabel,
  signInError,
  children
}: AuthFormProps & { supported: boolean }): React.JSX.Element {
  const id = useId()
  const edited = useRef(false)
  const reads = useRef(0)
  const observation = useSyncExternalStore(subscribeAntigravityChatSignIns, () =>
    readAntigravityChatSignInSnapshot(owner)
  )
  const [loaded, setLoaded] = useState(false)
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
  const [authenticatedMethod, setAuthenticatedMethod] = useState<string | null>(null)
  const [method, setMethod] = useState('oauth-personal')
  const [project, setProject] = useState('')
  const [location, setLocation] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<{
    message: string
    recovery: 'reload' | 'restart' | null
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const active =
    observation.kind === 'known' && antigravityChatSignInRunning(observation.state.flow)
  const unavailable = error?.recovery === 'reload' || error?.recovery === 'restart'
  const [attempt, setAttempt] = useState(0)
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  useEffect(() => {
    if (!supported) {
      return
    }
    let current = true
    setLoading(true)
    const read = reads.current
    const target: RuntimeClientTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    void callAntigravityChatAuthConfig(target).then(
      (config) => {
        if (current && read === reads.current) {
          setLoading(false)
          setLoaded(true)
          if (!edited.current) {
            if (observation.kind === 'known' && observation.state.auth === 'signedIn') {
              setAuthenticatedMethod(config?.method ?? null)
            }
            setMethod(config?.method ?? '')
            setProject(config?.gcpProject ?? '')
            setLocation(config?.gcpLocation ?? '')
          }
          setError(
            config
              ? null
              : {
                  message: translate(
                    'accounts.antigravity.settingsIncomplete',
                    'Choose an Antigravity account type and enter its Google Cloud project and location.'
                  ),
                  recovery: null
                }
          )
        }
      },
      (cause: unknown) => {
        if (current && read === reads.current) {
          setLoading(false)
          setError({
            message:
              isAntigravityChatAuthUnconfirmed(cause) && cause instanceof Error
                ? cause.message
                : translate(
                    'accounts.antigravity.settingsLoadFailed',
                    "Orca couldn't load your Antigravity sign-in settings. Try again."
                  ),
            recovery: isAntigravityChatAuthUnconfirmed(cause) ? 'restart' : 'reload'
          })
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
  const blocked = disabled || pending || preparing || !loaded || unavailable
  function save(value: unknown): Promise<boolean> {
    let config: AntigravityChatAuthConfig
    try {
      config = resolveAntigravityChatAuthConfig(value)
    } catch (cause) {
      setError({
        message:
          cause instanceof Error ? cause.message : 'Enter a Google Cloud project and location.',
        recovery: null
      })
      return Promise.resolve(false)
    }
    const key = JSON.stringify(config)
    if (saveInFlight.current) {
      return saveInFlight.current.key === key ? saveInFlight.current.result : Promise.resolve(false)
    }
    setError(null)
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
        setError(null)
        setMethod(next.method)
        setProject(next.gcpProject ?? '')
        setLocation(next.gcpLocation ?? '')
        return true
      })
      .catch((cause: unknown) => {
        if (mounted.current) {
          reads.current++
          setError({
            message:
              isAntigravityChatAuthUnconfirmed(cause) && cause instanceof Error
                ? cause.message
                : translate(
                    'accounts.antigravity.settingsSaveFailed',
                    "Orca couldn't save your Antigravity sign-in settings. Try again."
                  ),
            recovery: isAntigravityChatAuthUnconfirmed(cause) ? 'restart' : null
          })
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
    if (starting.current || disabled || !loaded || unavailable) {
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
  const commitText = () => {
    if (edited.current && !blocked) {
      void save(draft())
    }
  }
  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }
  return (
    <>
      {heading}
      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-method`} variant="settings">
            {translate('accounts.antigravity.authMethod', 'Sign in with')}
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
                {translate('accounts.antigravity.personal', 'Google account')}
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
        {error && !active && (
          <p role="alert" className="text-xs text-destructive">
            {error.message}
          </p>
        )}
        {error?.recovery === 'reload' && !active && (
          <Button
            size="xs"
            variant="outline"
            disabled={loading}
            onClick={() => setAttempt((value) => value + 1)}
          >
            {translate('common.retry', 'Retry')}
          </Button>
        )}
      </div>
      {(!unavailable || active) &&
        children({
          alert: error && !active ? null : (signInError ?? null),
          disabled: disabled || !loaded || !valid || preparing || unavailable,
          start,
          reauth: authenticatedMethod !== null && authenticatedMethod !== method,
          hint:
            !loaded || (method !== 'oauth-business' && method !== 'oauth-personal')
              ? null
              : authenticatedMethod !== null && authenticatedMethod !== method
                ? translate(
                    'accounts.antigravity.signInAgainWith',
                    'Sign in again to use {{method}}.',
                    {
                      method:
                        method === 'oauth-business'
                          ? translate('accounts.antigravity.enterprise', 'Gemini Enterprise')
                          : translate('accounts.antigravity.personal', 'Google account')
                    }
                  )
                : translate(
                    'accounts.antigravity.signInWith',
                    'Signs in with {{method}} on {{host}}.',
                    {
                      host: hostLabel,
                      method:
                        method === 'oauth-business'
                          ? translate('accounts.antigravity.enterprise', 'Gemini Enterprise')
                          : translate('accounts.antigravity.personal', 'Google account')
                    }
                  )
        })}
    </>
  )
}
