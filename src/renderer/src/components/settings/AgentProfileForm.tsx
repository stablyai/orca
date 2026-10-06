// A preview is tied to one form revision; host save revalidates it before registering a binding.
import { useEffect, useId, useRef, useState } from 'react'
import { AGENT_PROFILE_CAPABILITIES } from '../../../../shared/agent-profile-capabilities'
import type { AgentLaunchProfile, ProfileAgent } from '../../../../shared/agent-launch-profile'
import { validateAgentLaunchProfileName } from '../../../../shared/agent-launch-profile'
import type {
  AgentProfileCandidate,
  AgentProfileConnectionInput
} from '../../../../shared/agent-profile-connection'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsSegmentedControl } from './SettingsFormControls'
import {
  cancelProfileSignIn,
  profileAccounts,
  signInProfileAccount
} from './agent-profile-accounts'

type Props = {
  agent: ProfileAgent
  settings: GlobalSettings
  profile?: AgentLaunchProfile
  onClose: () => void
  onBusy: (busy: boolean) => void
}
export function AgentProfileForm({ agent, settings, profile, onClose, onBusy }: Props) {
  const id = useId()
  const capabilities = AGENT_PROFILE_CAPABILITIES[agent]
  const [name, setName] = useState(profile?.name ?? '')
  const [source, setSource] = useState<AgentProfileConnectionInput['source']>(
    profile?.binding.kind === 'external'
      ? { kind: 'home', value: profile.binding.home }
      : {
          kind: 'managed',
          accountId: profile?.binding.kind === 'managed' ? profile.binding.accountId : ''
        }
  )
  const [accounts, setAccounts] = useState(() => profileAccounts(settings, agent))
  const [preview, setPreview] = useState<AgentProfileCandidate | null>(null)
  const [pending, setPending] = useState<'preview' | 'login' | 'save' | 'folder' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const operation = useRef({
    revision: 0,
    mounted: true,
    login: false,
    pending: false
  })
  useEffect(() => {
    const current = operation.current
    current.mounted = true
    return () => {
      current.mounted = false
      current.revision++
      if (current.login) {
        void cancelProfileSignIn(agent).catch(() => {})
      }
    }
  }, [agent])
  const nameError = validateAgentLaunchProfileName(
    name,
    settings.agentLaunchProfiles ?? [],
    profile?.id
  )
  const changeSource = (next: AgentProfileConnectionInput['source']) => {
    operation.current.revision++
    setSource(next)
    setPreview(null)
    setFailure(null)
  }
  const run = async (
    kind: NonNullable<typeof pending>,
    action: (current: () => boolean) => Promise<void>
  ) => {
    if (operation.current.pending) {
      return
    }
    const revision = ++operation.current.revision
    operation.current.pending = true
    operation.current.login = kind === 'login'
    onBusy(kind === 'save')
    setPending(kind)
    setFailure(null)
    const current = () => operation.current.mounted && operation.current.revision === revision
    try {
      await action(current)
    } catch (error) {
      if (current()) {
        setFailure(
          error instanceof Error
            ? error.message
            : translate('agentProfiles.failed', 'Could not complete this action.')
        )
      }
    } finally {
      operation.current.pending = false
      operation.current.login = false
      if (operation.current.mounted) {
        setPending(null)
        onBusy(false)
      }
    }
  }
  const inspect = () =>
    run('preview', async (current) => {
      const result = await window.api.agentProfiles.preview({ agent, source })
      if (current()) {
        setPreview(result)
      }
    })
  const signIn = () =>
    run('login', async (current) => {
      const result = await signInProfileAccount(agent)
      if (!current()) {
        return
      }
      setAccounts(result)
      const added = result.filter(
        (account) => !accounts.some((existing) => existing.id === account.id)
      )
      changeSource({ kind: 'managed', accountId: added.length === 1 ? added[0].id : '' })
    })
  const chooseFolder = () =>
    run('folder', async (current) => {
      const folder = await window.api.repos.pickFolder()
      if (folder && current()) {
        changeSource({ kind: 'home', value: folder })
      }
    })
  const canInspect =
    source.kind === 'managed'
      ? accounts.some((account) => account.id === source.accountId)
      : Boolean(source.value.trim())
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (!preview || nameError) {
          return
        }
        void run('save', async (current) => {
          await window.api.agentProfiles.save({
            ...(profile ? { id: profile.id } : {}),
            name,
            connection: { agent, source }
          })
          if (current()) {
            onClose()
          }
        })
      }}
    >
      <div className="space-y-2">
        <Label htmlFor={`${id}-name`}>{translate('agentProfiles.name', 'Profile name')}</Label>
        <Input
          id={`${id}-name`}
          value={name}
          maxLength={60}
          disabled={pending === 'save'}
          onChange={(event) => setName(event.target.value)}
          aria-invalid={Boolean(name && nameError)}
        />
      </div>
      <SettingsSegmentedControl
        value={source.kind === 'managed' ? 'managed' : 'external'}
        ariaLabel={translate('agentProfiles.source', 'Profile source')}
        onChange={(value: 'managed' | 'external') => {
          if (!pending) {
            changeSource(
              value === 'managed'
                ? { kind: 'managed', accountId: '' }
                : { kind: 'command', value: '' }
            )
          }
        }}
        options={[
          {
            value: 'managed',
            label: translate('agentProfiles.create', 'Create new'),
            disabled: Boolean(pending) || !capabilities.create
          },
          {
            value: 'external',
            label: translate('agentProfiles.connect', 'Connect existing'),
            disabled: Boolean(pending) || !capabilities.connectHome
          }
        ]}
      />
      {source.kind === 'managed' ? (
        <div className="space-y-2">
          <Label htmlFor={`${id}-account`}>{translate('agentProfiles.account', 'Account')}</Label>
          <Select
            value={source.accountId}
            disabled={Boolean(pending)}
            onValueChange={(accountId) => {
              if (accountId) {
                changeSource({ kind: 'managed', accountId })
              }
            }}
          >
            <SelectTrigger id={`${id}-account`}>
              <SelectValue
                placeholder={translate('agentProfiles.chooseAccount', 'Choose an account')}
              />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={Boolean(pending)}
            onClick={() => void signIn()}
          >
            {translate('agentProfiles.signIn', 'Sign in to another account')}
          </Button>
          {pending === 'login' && (
            <p role="status" className="text-xs text-muted-foreground">
              {translate('agentProfiles.signingIn', 'Waiting for sign-in in your browser…')}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor={`${id}-source`}>
            {source.kind === 'home'
              ? translate('agentProfiles.folder', 'Configuration folder')
              : translate('agentProfiles.command', 'Command or alias')}
          </Label>
          <Input
            id={`${id}-source`}
            value={source.value}
            disabled={Boolean(pending)}
            onChange={(event) => changeSource({ kind: source.kind, value: event.target.value })}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={Boolean(pending)}
              onClick={() => void chooseFolder()}
            >
              {translate('agentProfiles.chooseFolder', 'Choose folder')}
            </Button>
            {source.kind === 'home' && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={Boolean(pending)}
                onClick={() => changeSource({ kind: 'command', value: '' })}
              >
                {translate('agentProfiles.useCommand', 'Use command')}
              </Button>
            )}
          </div>
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={Boolean(pending) || !canInspect}
        onClick={() => void inspect()}
      >
        {translate('agentProfiles.preview', 'Check connection')}
      </Button>
      {preview && (
        <div className="space-y-1 text-xs text-muted-foreground" role="status">
          <p>
            {preview.identity.kind === 'verified'
              ? preview.identity.displayName
              : translate('agentProfiles.unverified', 'Unverified configuration')}
          </p>
          {preview.identity.kind === 'verified' && (
            <p>{translate('agentProfiles.verified', 'Verified account')}</p>
          )}
          <p className="break-all font-mono">{preview.executable}</p>
          <p className="break-all font-mono">{preview.resolvedHome}</p>
          {preview.identity.kind === 'unverified' && (
            <p>
              {translate(
                'agentProfiles.terminalOnly',
                'Starts a new terminal. Existing conversations require verified ownership. Another terminal can change this folder’s sign-in.'
              )}
            </p>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {translate(
          'agentProfiles.futureOnly',
          'Changes apply to future launches. Existing sessions keep their original binding. Accounts and folders remain when a profile is unlinked.'
        )}
      </p>
      {(failure || (name && nameError)) && (
        <p role="alert" className="text-xs text-destructive">
          {failure || nameError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending === 'save'}
          onClick={onClose}
        >
          {translate('agentProfiles.cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={Boolean(pending) || Boolean(nameError) || !preview}
        >
          {translate('agentProfiles.save', 'Save profile')}
        </Button>
      </div>
    </form>
  )
}
