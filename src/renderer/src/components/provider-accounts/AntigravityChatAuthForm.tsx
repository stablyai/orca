import {
  antigravityChatSignInRunning,
  readAntigravityChatSignInSnapshot,
  subscribeAntigravityChatSignIns
} from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { callAntigravityChatAuthConfig } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import {
  ANTIGRAVITY_CHAT_AUTH_CONFIG_RUNTIME_CAPABILITY,
  ANTIGRAVITY_CHAT_KEY_AND_ADC_AUTH_RUNTIME_CAPABILITY
} from '../../../../shared/remote-runtime/protocol/account-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  resolveAntigravityChatAuthConfig,
  type AntigravityChatAuthConfig
} from '../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { AntigravityChatAuthSettingRow } from './AntigravityChatAuthSettingRow'
import { AntigravityChatApiKeyField } from './AntigravityChatApiKeyField'
import { AntigravityChatGcpFields } from './AntigravityChatGcpFields'
import type { AntigravityChatApiKeyStatus } from '../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import {
  AntigravityChatAuthMethodItems,
  antigravityChatAuthMethodLabel
} from './AntigravityChatAuthMethodItems'
import { Select, SelectContent, SelectTrigger, SelectValue } from '../ui/select'

export type AntigravityChatAuthAction = {
  disabled: boolean
  start: () => void
  /** Display name of the method Sign in will use; null when it is not known yet. */
  method: string | null
  /** The method id picked in the form. */
  pickedMethod: string
  /** Enterprise needs a project and location before it can be saved or used. */
  incomplete: boolean
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
  /** After a saved sign-in method, which decides where new chats run. */
  onSaved?: () => void
  children: (action: AntigravityChatAuthAction) => ReactNode
}

const unwrapped = (fields: ReactNode): ReactNode => fields

export function AntigravityChatAuthForm(props: AuthFormProps): React.JSX.Element | null {
  const { owner, heading, onSignIn, signInError, children } = props
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
          // A host without the method setting signs in with a Google account only.
          pickedMethod: 'oauth-personal',
          incomplete: false,
          recovering: false,
          alert: signInError ?? null
        })}
      </>
    )
  }
  const key = owner.kind === 'local' ? 'local' : owner.environmentId
  return <AuthForm key={key} {...props} supported={capability === 'supported'} />
}

function AuthForm({
  owner,
  disabled,
  supported,
  onSignIn,
  heading,
  signInError,
  fieldsRow = unwrapped,
  onSaved,
  children
}: AuthFormProps & { supported: boolean }): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const keyAndAdc =
    useStructuredAgentSessionHostCapabilityState(
      owner,
      ANTIGRAVITY_CHAT_KEY_AND_ADC_AUTH_RUNTIME_CAPABILITY
    ) === 'supported'
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
  const [method, setMethod] = useState('oauth-personal')
  const [project, setProject] = useState('')
  const [location, setLocation] = useState('')
  const [pending, setPending] = useState(false)
  const [keyStatus, setKeyStatus] = useState<AntigravityChatApiKeyStatus | null>(null)
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
    [environmentId]
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
        onSaved?.()
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
  const methodName = antigravityChatAuthMethodLabel(method, t)
  const usesGcp = method === 'oauth-business' || method === 'agent-platform'
  const keyMissing =
    method === 'gemini-api-key' &&
    keyStatus !== null &&
    !keyStatus.saved &&
    !keyStatus.inEnvironment
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
                  <AntigravityChatAuthMethodItems keyAndAdc={keyAndAdc} />
                </SelectContent>
              </Select>
            </AntigravityChatAuthSettingRow>
            {usesGcp && (
              <AntigravityChatGcpFields
                id={id}
                project={project}
                location={location}
                optional={method === 'agent-platform'}
                disabled={blocked}
                onProject={(value) => {
                  edited.current = true
                  setProject(value)
                  setError(null)
                }}
                onLocation={(value) => {
                  edited.current = true
                  setLocation(value)
                  setError(null)
                }}
                onCommit={commitText}
              />
            )}
            {method === 'gemini-api-key' && keyAndAdc && (
              <AntigravityChatApiKeyField
                owner={owner}
                disabled={blocked}
                onStatus={setKeyStatus}
              />
            )}
          </div>
        )}
      {children({
        alert: error && !active ? error.message : (signInError ?? null),
        recovering: unavailable,
        disabled: disabled || preparing || (!unavailable && (!loaded || !valid)) || keyMissing,
        start,
        method: unavailable || !loaded ? null : methodName,
        pickedMethod: method,
        incomplete: loaded && !unavailable && !valid && usesGcp
      })}
    </>
  )
}
