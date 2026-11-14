import {
  antigravityChatSignInRunning,
  readAntigravityChatSignInSnapshot,
  subscribeAntigravityChatSignIns
} from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { callAntigravityChatAuthConfig } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { ANTIGRAVITY_CHAT_AUTH_CONFIG_RUNTIME_CAPABILITY } from '../../../../shared/account-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  resolveAntigravityChatAuthConfig,
  type AntigravityChatAuthConfig
} from '../../../../shared/antigravity-chat-auth-config'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { AntigravityChatAuthSettingRow } from './AntigravityChatAuthSettingRow'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

export type AntigravityChatAuthAction = {
  disabled: boolean
  start: () => void
  /** Display name of the method Sign in will use; null when it is not known yet. */
  method: string | null
  /** Enterprise needs a project and location before it can be saved or used. */
  incomplete: boolean
  reauth: boolean
  alert: string | null
  recovering: boolean
}
type AuthFormProps = {
  owner: RuntimeClientTarget
  disabled: boolean
  onSignIn: () => void
  heading: ReactNode
  signInError?: string | null
  /** Wraps the method and Enterprise fields, e.g. as one settings row. */
  fieldsRow?: (fields: ReactNode) => ReactNode
  children: (action: AntigravityChatAuthAction) => ReactNode
}

const unwrapped = (fields: ReactNode): ReactNode => fields

export function AntigravityChatAuthForm({
  owner,
  disabled,
  onSignIn,
  heading,
  signInError,
  fieldsRow,
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
          method: null,
          incomplete: false,
          reauth: false,
          recovering: false,
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
      signInError={signInError}
      fieldsRow={fieldsRow}
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
  signInError,
  fieldsRow = unwrapped,
  children
}: AuthFormProps & { supported: boolean }): React.JSX.Element {
  const t = useTranslate()
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
    recovery: 'reload' | null
  } | null>(null)
  const active =
    observation.kind === 'known' && antigravityChatSignInRunning(observation.state.flow)
  const unavailable = error?.recovery === 'reload'
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null
  const load = useCallback(
    async (current: () => boolean = () => mounted.current) => {
      const read = ++reads.current
      try {
        const target: RuntimeClientTarget =
          environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
        const config = await callAntigravityChatAuthConfig(target)
        if (!current() || !mounted.current || read !== reads.current) {
          return undefined
        }
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
        return config
      } catch {
        if (current() && mounted.current && read === reads.current) {
          setError({
            message: translate(
              'accounts.antigravity.settingsLoadFailed',
              "Orca couldn't load your Antigravity sign-in settings. Try again."
            ),
            recovery: 'reload'
          })
        }
        return undefined
      }
    },
    [environmentId, observation]
  )
  useEffect(() => {
    if (!supported) {
      return
    }
    let current = true
    void load(() => current)
    return () => {
      current = false
    }
  }, [supported, load])
  const draft = (nextMethod = method, nextProject = project, nextLocation = location) => ({
    method: nextMethod,
    ...(nextProject ? { gcpProject: nextProject } : {}),
    ...(nextLocation ? { gcpLocation: nextLocation } : {})
  })
  const complete = (value: ReturnType<typeof draft>): boolean => {
    try {
      resolveAntigravityChatAuthConfig(value)
      return true
    } catch {
      return false
    }
  }
  // Incomplete Enterprise fields stay an unsaved draft so the host keeps its saved method.
  const valid = complete(draft())
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
      .catch(() => {
        if (mounted.current) {
          reads.current++
          setError({
            message: t(
              'accounts.antigravity.settingsSaveFailed',
              "Orca couldn't save your Antigravity sign-in settings. Try again."
            ),
            recovery: null
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
    if (starting.current || disabled || (!loaded && !unavailable)) {
      return
    }
    starting.current = true
    setPreparing(true)
    const prepare = async () => {
      if (unavailable) {
        const config = await load()
        if (!config || !mounted.current) {
          return false
        }
        return save(edited.current ? draft() : config)
      }
      return save(draft())
    }
    void prepare()
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
    if (edited.current && !blocked && valid) {
      void save(draft())
    }
  }
  const commitOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }
  const methodName = methodLabel(method, t)
  return (
    <>
      {heading}
      {!unavailable &&
        fieldsRow(
          <div className="space-y-3">
            <AntigravityChatAuthSettingRow
              htmlFor={`${id}-method`}
              label={t('accounts.antigravity.authMethod', 'Sign in with')}
            >
              <Select
                value={method}
                disabled={blocked}
                onValueChange={(value) => {
                  edited.current = true
                  setMethod(value)
                  if (complete(draft(value))) {
                    void save(draft(value))
                  }
                }}
              >
                <SelectTrigger id={`${id}-method`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    value="oauth-personal"
                    description={t(
                      'accounts.antigravity.personalOption',
                      'Your personal Google AI plan'
                    )}
                  >
                    {methodLabel('oauth-personal', t)}
                  </SelectItem>
                  <SelectItem
                    value="oauth-business"
                    description={t(
                      'accounts.antigravity.enterpriseOption',
                      "Your organization's license"
                    )}
                  >
                    {methodLabel('oauth-business', t)}
                  </SelectItem>
                </SelectContent>
              </Select>
            </AntigravityChatAuthSettingRow>
            {method === 'oauth-business' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={`${id}-project`}>
                    {t('accounts.antigravity.gcpProject', 'Google Cloud project')}
                  </Label>
                  <Input
                    id={`${id}-project`}
                    value={project}
                    disabled={blocked}
                    placeholder={t('accounts.antigravity.projectPlaceholder', 'my-project-id')}
                    onChange={(event) => {
                      edited.current = true
                      setProject(event.target.value)
                      setError(null)
                    }}
                    onBlur={commitText}
                    onKeyDown={commitOnEnter}
                  />
                </div>
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor={`${id}-location`}>
                    {t('accounts.antigravity.location', 'Location')}
                  </Label>
                  <Input
                    id={`${id}-location`}
                    value={location}
                    disabled={blocked}
                    placeholder={t('accounts.antigravity.locationPlaceholder', 'us-central1')}
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
          </div>
        )}
      {children({
        alert: error && !active ? error.message : (signInError ?? null),
        recovering: unavailable,
        disabled: disabled || preparing || (!unavailable && (!loaded || !valid)),
        start,
        reauth: authenticatedMethod !== null && authenticatedMethod !== method,
        method: unavailable || !loaded ? null : methodName,
        incomplete: loaded && !unavailable && !valid && method === 'oauth-business'
      })}
    </>
  )
}

function methodLabel(method: string, t: Translate = translate): string | null {
  if (method === 'oauth-business') {
    return t('accounts.antigravity.enterprise', 'Gemini Enterprise')
  }
  return method === 'oauth-personal' ? t('accounts.antigravity.personal', 'Google account') : null
}
