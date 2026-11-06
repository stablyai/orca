import {
  readAntigravityChatSignInSnapshot,
  subscribeAntigravityChatSignIns
} from '@/runtime/antigravity-chat-sign-in-status'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
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

export function AntigravityChatAuthForm({
  owner,
  disabled
}: {
  owner: RuntimeClientTarget
  disabled: boolean
}): React.JSX.Element | null {
  const capability = useStructuredAgentSessionHostCapabilityState(
    owner,
    ANTIGRAVITY_CHAT_AUTH_CONFIG_RUNTIME_CAPABILITY
  )
  if (capability === 'unsupported') {
    return null
  }
  const key = owner.kind === 'local' ? 'local' : owner.environmentId
  return (
    <AuthForm key={key} owner={owner} disabled={disabled} supported={capability === 'supported'} />
  )
}

function AuthForm({
  owner,
  disabled,
  supported
}: {
  owner: RuntimeClientTarget
  disabled: boolean
  supported: boolean
}): React.JSX.Element {
  const id = useId()
  const edited = useRef(false)
  const reads = useRef(0)
  const observation = useSyncExternalStore(subscribeAntigravityChatSignIns, () =>
    readAntigravityChatSignInSnapshot(owner)
  )
  const [loaded, setLoaded] = useState(false)
  const [saved, setSaved] = useState<AntigravityChatAuthConfig | null>(null)
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
          setSaved(config)
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
  const draft =
    method === 'oauth-business'
      ? { method, gcpProject: project, gcpLocation: location }
      : {
          method,
          ...(project ? { gcpProject: project } : {}),
          ...(location ? { gcpLocation: location } : {})
        }
  const changed = loaded && JSON.stringify(draft) !== JSON.stringify(saved)
  const blocked = disabled || pending || !loaded
  async function apply(): Promise<void> {
    setError(null)
    let config: AntigravityChatAuthConfig
    try {
      config = resolveAntigravityChatAuthConfig(draft)
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Enter a Google Cloud project and location.'
      )
      return
    }
    reads.current++
    setPending(true)
    try {
      const next = resolveAntigravityChatAuthConfig(
        await callAntigravityChatAuthConfig(owner, config)
      )
      reads.current++
      edited.current = false
      setSaved(next)
      setMethod(next.method)
      setProject(next.gcpProject ?? '')
      setLocation(next.gcpLocation ?? '')
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'Antigravity account settings could not be saved.'
      )
    } finally {
      setPending(false)
    }
  }
  return (
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
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label htmlFor={`${id}-project`} variant="settings">
            {translate('accounts.antigravity.gcpProject', 'Google Cloud project')}
          </Label>
          <Input
            id={`${id}-project`}
            density="compact"
            value={project}
            disabled={blocked || method !== 'oauth-business'}
            placeholder={translate('accounts.antigravity.projectPlaceholder', 'my-project-id')}
            onChange={(event) => {
              edited.current = true
              setProject(event.target.value)
            }}
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
            disabled={blocked || method !== 'oauth-business'}
            placeholder={translate('accounts.antigravity.locationPlaceholder', 'us-central1')}
            onChange={(event) => {
              edited.current = true
              setLocation(event.target.value)
            }}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {error && !loaded ? (
        <Button size="xs" variant="outline" onClick={() => setAttempt((value) => value + 1)}>
          {translate('common.retry', 'Retry')}
        </Button>
      ) : (
        <Button
          size="xs"
          variant="outline"
          disabled={blocked || !changed}
          onClick={() => void apply()}
        >
          {translate('accounts.antigravity.applyAuth', 'Apply account settings')}
        </Button>
      )}
    </div>
  )
}
