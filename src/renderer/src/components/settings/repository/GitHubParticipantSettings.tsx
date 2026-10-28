import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { GhAccountBindingInventory } from '../../../../../shared/github/auth-types'
import type { GhAccountBinding } from '../../../../../shared/github/account-binding'
import type {
  GitHubParticipant,
  GitHubParticipantSettingsStatus
} from '../../../../../shared/github/participant-accounts'
import { GITHUB_PARTICIPANT_ACCOUNTS_CAPABILITY } from '../../../../../shared/github/participant-accounts'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { getRuntimeTargetHostId } from '@/runtime/runtime-client-target'
import { useAppStore } from '@/store/index'
import { subscribeGitHubParticipantAccountsChanged } from '@/runtime/github-participant-account-changes'
import { invalidateGitHubParticipantReads } from '@/runtime/github-participant-read-fencing'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { Switch } from '../../ui/switch'
import { Label } from '../../ui/label'
import { GitHubParticipantAccountPicker } from './GitHubParticipantAccountPicker'
import { GitHubParticipantEditor } from './GitHubParticipantEditor'

type LoadState =
  | { kind: 'loading' }
  | { kind: 'legacy' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; status: GitHubParticipantSettingsStatus }

type ParticipantMutationParams =
  | { enabled: boolean }
  | { id: string }
  | (Omit<GitHubParticipant, 'id'> & { id?: string })
  | { account: GhAccountBinding | null }

export function GitHubParticipantSettings({
  repoId,
  repoPath,
  runtimeTarget,
  inventory,
  children
}: {
  repoId: string
  repoPath?: string
  runtimeTarget: RuntimeClientTarget
  inventory: GhAccountBindingInventory | null
  children: ReactNode
}): React.JSX.Element {
  const scope = `${runtimeTarget.kind === 'environment' ? runtimeTarget.environmentId : 'local'}:${repoId}`
  return (
    <ParticipantSettingsForHost
      key={scope}
      repoId={repoId}
      repoPath={repoPath}
      runtimeTarget={runtimeTarget}
      inventory={inventory}
    >
      {children}
    </ParticipantSettingsForHost>
  )
}

function ParticipantSettingsForHost({
  repoId,
  repoPath,
  runtimeTarget,
  inventory,
  children
}: Parameters<typeof GitHubParticipantSettings>[0]): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [revision, setRevision] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<GitHubParticipant | null>(null)
  const [editor, setEditor] = useState<GitHubParticipant | 'new' | null>(null)
  const previousIdentity = useRef<string | null>(null)
  const accountChangeGeneration = useRef(0)
  const applyStatus = useCallback(
    (status: GitHubParticipantSettingsStatus) => {
      const identity = JSON.stringify([
        status.enabled,
        status.isOwner,
        status.participantId,
        status.selectedAccount?.host.toLowerCase(),
        status.selectedAccount?.user.toLowerCase(),
        status.allowedAccounts
          .map((account) => `${account.host.toLowerCase()}/${account.user.toLowerCase()}`)
          .sort()
      ])
      if (
        previousIdentity.current !== identity &&
        (status.enabled || previousIdentity.current !== null)
      ) {
        invalidateGitHubParticipantReads(runtimeTarget, repoId)
        if (repoPath) {
          invalidateGitHubParticipantReads(runtimeTarget, repoPath)
        }
        useAppStore
          .getState()
          .evictGitHubRepoCaches(repoId, repoPath, getRuntimeTargetHostId(runtimeTarget))
      }
      previousIdentity.current = identity
      setState({ kind: 'ready', status })
    },
    [repoId, repoPath, runtimeTarget]
  )
  const active = useRef(true)
  const busy = useRef(false)
  const toggleId = useId()
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
    }
  }, [])
  useEffect(
    () =>
      subscribeGitHubParticipantAccountsChanged(runtimeTarget, () => {
        accountChangeGeneration.current += 1
        setState({ kind: 'loading' })
        setRevision((value) => value + 1)
      }),
    [runtimeTarget]
  )
  useEffect(() => {
    let cancelled = false
    const generation = accountChangeGeneration.current
    setState({ kind: 'loading' })
    const load = async () => {
      try {
        const host = await callRuntimeRpc<{ capabilities?: readonly string[] }>(
          runtimeTarget,
          'status.get'
        )
        if (cancelled || generation !== accountChangeGeneration.current) {
          return
        }
        if (!host?.capabilities?.includes(GITHUB_PARTICIPANT_ACCOUNTS_CAPABILITY)) {
          setState({ kind: 'legacy' })
          return
        }
        const status = await callRuntimeRpc<GitHubParticipantSettingsStatus>(
          runtimeTarget,
          'github.participants.status',
          { repo: repoId }
        )
        if (!cancelled && generation === accountChangeGeneration.current) {
          applyStatus(status)
        }
      } catch (cause) {
        if (cancelled || generation !== accountChangeGeneration.current) {
          return
        }
        setState({ kind: 'error', message: cause instanceof Error ? cause.message : String(cause) })
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [repoId, runtimeTarget, revision, applyStatus])

  async function mutate(
    method: 'setEnabled' | 'remove' | 'save' | 'select',
    params: ParticipantMutationParams
  ): Promise<boolean> {
    if (busy.current) {
      return false
    }
    busy.current = true
    const generation = accountChangeGeneration.current
    setSaving(true)
    setError(null)
    try {
      const status = await callRuntimeRpc<GitHubParticipantSettingsStatus>(
        runtimeTarget,
        `github.participants.${method}`,
        { repo: repoId, ...params }
      )
      if (!active.current) {
        return false
      }
      if (generation === accountChangeGeneration.current) {
        applyStatus(status)
      }
      return true
    } catch (cause) {
      if (active.current) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      return false
    } finally {
      busy.current = false
      if (active.current) {
        setSaving(false)
      }
    }
  }

  if (state.kind === 'legacy') {
    return <>{children}</>
  }
  if (state.kind === 'loading') {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        {translate('settings.githubParticipants.loading', 'Checking GitHub account access…')}
      </p>
    )
  }
  if (state.kind === 'error') {
    return (
      <div className="space-y-2">
        <p className="text-xs text-destructive" role="alert">
          {state.message}
        </p>
        <Button size="sm" variant="outline" onClick={() => setRevision((value) => value + 1)}>
          {translate('settings.githubParticipants.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  const { status } = state
  const personal = status.enabled && !status.isOwner
  const participants = status.participants ?? []
  return (
    <div className="space-y-3">
      {status.isOwner ? (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-1">
              <Label htmlFor={toggleId}>
                {translate(
                  'settings.githubParticipants.enable',
                  'Use separate GitHub accounts for members'
                )}
              </Label>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'settings.githubParticipants.description',
                  'Assign paired devices and allowed accounts to each member on this server. Members choose their own account for this project.'
                )}
              </p>
            </div>
            <Switch
              id={toggleId}
              checked={status.enabled}
              disabled={saving}
              onCheckedChange={(enabled) => void mutate('setEnabled', { enabled })}
            />
          </div>
          {status.enabled ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'settings.githubParticipants.enforcement',
                'Devices without a member or a selected account cannot make project GitHub calls. The server owner continues using the account below.'
              )}
            </p>
          ) : null}
          {participants.map((participant) => (
            <div key={participant.id} className="flex items-center justify-between gap-2">
              <span className="text-sm">{participant.name}</span>
              <div className="flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={saving}
                  onClick={() => {
                    setEditor(participant)
                    setRemoving(null)
                    setError(null)
                  }}
                >
                  {translate('settings.githubParticipants.edit', 'Edit')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => {
                    setRemoving(participant)
                    setEditor(null)
                  }}
                >
                  {translate('settings.githubParticipants.remove', 'Remove')}
                </Button>
              </div>
            </div>
          ))}
          {removing ? (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-xs">
                {translate(
                  'settings.githubParticipants.removePrompt',
                  'Remove {{name}} from this server? Their devices will lose member access.',
                  { name: removing.name }
                )}
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={saving}
                  onClick={() =>
                    void mutate('remove', { id: removing.id }).then((saved) => {
                      if (saved) {
                        setRemoving(null)
                      }
                    })
                  }
                >
                  {translate('settings.githubParticipants.confirmRemove', 'Remove member')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={saving}
                  onClick={() => setRemoving(null)}
                >
                  {translate('settings.githubParticipants.cancel', 'Cancel')}
                </Button>
              </div>
            </div>
          ) : null}
          {editor ? (
            <GitHubParticipantEditor
              key={editor === 'new' ? 'new' : editor.id}
              participant={editor === 'new' ? undefined : editor}
              participants={participants}
              devices={status.devices ?? []}
              accounts={(inventory?.accounts ?? [])
                .filter((account) => account.source === 'keyring')
                .map(({ host, user }) => ({ host, user }))}
              saving={saving}
              onCancel={() => setEditor(null)}
              onSave={async (value) => {
                if (await mutate('save', value)) {
                  setEditor(null)
                }
              }}
            />
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setEditor('new')
                setRemoving(null)
              }}
            >
              {translate('settings.githubParticipants.add', 'Add member')}
            </Button>
          )}
        </div>
      ) : null}
      {personal ? (
        <GitHubParticipantAccountPicker
          status={status}
          saving={saving}
          onSelect={(account) => void mutate('select', { account })}
          onRefresh={() => setRevision((value) => value + 1)}
        />
      ) : (
        <>
          {status.enabled ? (
            <p className="text-xs font-semibold">
              {translate(
                'settings.githubParticipants.ownerAccount',
                'Server owner’s project account'
              )}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {translate(
                'settings.githubParticipants.sharedAccount',
                'This account binding is shared by clients using this project on this server.'
              )}
            </p>
          )}
          {children}
        </>
      )}
      {status.error ? (
        <p className="text-xs text-destructive" role="alert">
          {status.error}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
