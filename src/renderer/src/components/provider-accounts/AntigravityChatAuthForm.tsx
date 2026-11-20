import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { callAntigravityChatAuthConfig } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import { refreshAntigravityChatAuthDetection } from '@/runtime/provider-accounts/sign-in/antigravity-chat-auth-detection'
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
import { AntigravityChatAuthMethodItems } from './AntigravityChatAuthMethodItems'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectTrigger, SelectValue } from '../ui/select'

type Method = AntigravityChatAuthConfig['method']

/** How the host's Antigravity chats sign in: agy's own Google login, or a Gemini API key or gcloud
 *  that Orca hands agy. Saving applies at once; nothing here signs anyone in. */
export function AntigravityChatAuthForm(props: {
  owner: RuntimeClientTarget
  disabled: boolean
  /** Told the saved method, so the section can describe it. */
  onMethod?: (method: Method | null) => void
}): React.JSX.Element | null {
  const supported =
    useStructuredAgentSessionHostCapabilityState(
      props.owner,
      ANTIGRAVITY_CHAT_AUTH_CONFIG_RUNTIME_CAPABILITY
    ) === 'supported'
  if (!supported) {
    return null
  }
  const key = props.owner.kind === 'local' ? 'local' : props.owner.environmentId
  return <AuthForm key={key} {...props} />
}

function AuthForm({
  owner,
  disabled,
  onMethod
}: {
  owner: RuntimeClientTarget
  disabled: boolean
  onMethod?: (method: Method | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const keyAndAdc =
    useStructuredAgentSessionHostCapabilityState(
      owner,
      ANTIGRAVITY_CHAT_KEY_AND_ADC_AUTH_RUNTIME_CAPABILITY
    ) === 'supported'
  const mounted = useRef(true)
  // A read that lands after a save would show the older choice.
  const reads = useRef(0)
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [method, setMethod] = useState<Method>('oauth-personal')
  const [project, setProject] = useState('')
  const [location, setLocation] = useState('')
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null

  const show = useCallback(
    (config: AntigravityChatAuthConfig) => {
      setMethod(config.method)
      setProject(config.gcpProject ?? '')
      setLocation(config.gcpLocation ?? '')
      onMethod?.(config.method)
    },
    [onMethod]
  )
  const load = useCallback(async () => {
    const read = ++reads.current
    setLoadFailed(false)
    try {
      const target: RuntimeClientTarget =
        environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
      const config = await callAntigravityChatAuthConfig(target)
      if (mounted.current && read === reads.current) {
        setLoaded(true)
        show(config ?? { method: 'oauth-personal' })
      }
    } catch {
      if (mounted.current && read === reads.current) {
        setLoadFailed(true)
      }
    }
  }, [environmentId, show])
  useEffect(() => {
    mounted.current = true
    void load()
    return () => {
      mounted.current = false
    }
  }, [load])

  const save = (next: { method: Method; gcpProject?: string; gcpLocation?: string }): void => {
    let config: AntigravityChatAuthConfig
    try {
      config = resolveAntigravityChatAuthConfig(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : null)
      return
    }
    reads.current++
    setPending(true)
    setError(null)
    callAntigravityChatAuthConfig(owner, config)
      .then((saved) => mounted.current && show(resolveAntigravityChatAuthConfig(saved)))
      .catch(() => {
        if (mounted.current) {
          setError(
            t(
              'accounts.antigravity.settingsSaveFailed',
              "Orca couldn't save your Antigravity sign-in settings. Try again."
            )
          )
        }
      })
      .finally(() => {
        // Chats on this host show the method; they read it again now rather than at next focus.
        void refreshAntigravityChatAuthDetection(owner, { force: true })
        if (mounted.current) {
          setPending(false)
        }
      })
  }
  const withProject = (nextMethod: Method) => ({
    method: nextMethod,
    ...(project ? { gcpProject: project } : {}),
    ...(location ? { gcpLocation: location } : {})
  })
  const blocked = disabled || pending || !loaded

  if (loadFailed) {
    return (
      <div data-settings-row="" className="flex items-center justify-between gap-4 py-3">
        <p className="text-sm text-muted-foreground">
          {t(
            'accounts.antigravity.settingsLoadFailed',
            "Orca couldn't load your Antigravity sign-in settings. Try again."
          )}
        </p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          {t('accounts.antigravity.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  return (
    <div data-settings-row="" className="space-y-3 py-3">
      <AntigravityChatAuthSettingRow
        htmlFor={`${id}-method`}
        label={t('accounts.antigravity.authMethod', 'Sign in with')}
      >
        <Select
          value={method}
          disabled={blocked}
          onValueChange={(value) => {
            const next = keyAndAdc && (value === 'gemini-api-key' || value === 'agent-platform')
            save(withProject(next ? value : 'oauth-personal'))
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
      {method === 'agent-platform' && (
        <AntigravityChatGcpFields
          id={id}
          project={project}
          location={location}
          optional
          disabled={blocked}
          onProject={setProject}
          onLocation={setLocation}
          onCommit={() => save(withProject(method))}
        />
      )}
      {method === 'gemini-api-key' && keyAndAdc && (
        <AntigravityChatApiKeyField owner={owner} disabled={blocked} />
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
