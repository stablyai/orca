import { useEffect, useId, useState } from 'react'
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
    const target: RuntimeClientTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    void callAntigravityChatAuthConfig(target).then(
      (config) => {
        if (current) {
          setSaved(config)
          setLoaded(true)
          setMethod(config?.method ?? '')
          setProject(config?.method === 'oauth-business' ? config.gcpProject : '')
          setLocation(config?.method === 'oauth-business' ? config.gcpLocation : '')
          setError(
            config
              ? null
              : 'Choose an Antigravity account type and enter its Google Cloud project and location.'
          )
        }
      },
      (cause: unknown) => {
        if (current) {
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
  }, [environmentId, supported, attempt])
  const draft =
    method === 'oauth-business'
      ? { method, gcpProject: project, gcpLocation: location }
      : { method }
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
    setPending(true)
    try {
      const next = resolveAntigravityChatAuthConfig(
        await callAntigravityChatAuthConfig(owner, config)
      )
      setSaved(next)
      setMethod(next.method)
      setProject(next.method === 'oauth-business' ? next.gcpProject : '')
      setLocation(next.method === 'oauth-business' ? next.gcpLocation : '')
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
        <Label htmlFor={`${id}-method`} className="text-xs">
          {translate('accounts.antigravity.authMethod', 'Sign-in method')}
        </Label>
        <Select value={method} disabled={blocked} onValueChange={setMethod}>
          <SelectTrigger id={`${id}-method`} className="h-8 text-xs">
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
          <Label htmlFor={`${id}-project`} className="text-xs">
            {translate('accounts.antigravity.gcpProject', 'Google Cloud project')}
          </Label>
          <Input
            id={`${id}-project`}
            className="h-8 text-xs"
            value={project}
            disabled={blocked || method !== 'oauth-business'}
            placeholder="my-project-id"
            onChange={(event) => setProject(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-location`} className="text-xs">
            {translate('accounts.antigravity.gcpLocation', 'Google Cloud location')}
          </Label>
          <Input
            id={`${id}-location`}
            className="h-8 text-xs"
            value={location}
            disabled={blocked || method !== 'oauth-business'}
            placeholder="us-central1"
            onChange={(event) => setLocation(event.target.value)}
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
