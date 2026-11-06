import { parseRemoteRepo } from '../right-sidebar/source-control/review/remote-repo'
import { useState } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type {
  PrFollowUpsPatch,
  PrFollowUpsSettings
} from '../../../../shared/pr-follow-ups/settings'
import { patchPrFollowUps, resolvePrFollowUps } from '../../../../shared/pr-follow-ups/settings'
import { useAppStore } from '../../store'
import { getRepoHostIdentity } from '../../../../shared/repo-host-identity'
import {
  getSettingsFocusedExecutionHostId,
  getRepoExecutionHostId
} from '../../../../shared/execution-host'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { usePrFollowUps } from './follow-up-resource'

export function PrFollowUpSettings({
  global,
  repo
}: {
  global?: PrFollowUpsSettings
  repo?: Repo
}): React.JSX.Element | null {
  const { available } = usePrFollowUps()
  const focusedHost = useAppStore((state) => getSettingsFocusedExecutionHostId(state.settings))
  const [saved, setSaved] = useState<{
    owner: string
    base: PrFollowUpsSettings | undefined
    value: PrFollowUpsSettings
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const owner = repo ? getRepoHostIdentity(repo) : focusedHost
  const persisted = repo ? repo.prFollowUps : global
  const raw = saved?.owner === owner && saved.base === persisted ? saved.value : persisted
  const resolved = resolvePrFollowUps(repo ? global : raw, repo ? raw : undefined)
  const paired = (repo ? getRepoExecutionHostId(repo) : focusedHost).startsWith('runtime:')
  if (
    !available ||
    repo?.kind === 'folder' ||
    parseRemoteRepo(repo?.gitRemoteIdentity?.remoteUrl ?? '')?.provider === 'gitlab'
  ) {
    return null
  }
  const write = async (patch: PrFollowUpsPatch): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await (repo
        ? window.api.repos.update({
            repoId: repo.id,
            hostId: getRepoExecutionHostId(repo),
            updates: { prFollowUpsPatch: patch }
          })
        : callRuntimeRpc({ kind: 'local' }, 'settings.update', { prFollowUpsPatch: patch }))
      setSaved({ owner, base: persisted, value: patchPrFollowUps(raw, patch) })
    } catch {
      setError('Could not save automatic follow-ups. Try again.')
    } finally {
      setSaving(false)
    }
  }
  const select = (
    label: string,
    value: string,
    path: PrFollowUpsPatch['path'],
    choices: [string, string][]
  ) => (
    <div className="flex items-center justify-between gap-4">
      <Label>{label}</Label>
      <Select
        value={value}
        disabled={saving || paired}
        onValueChange={(next) =>
          void write({
            path,
            value:
              next === 'inherit'
                ? null
                : path === 'enabled'
                  ? next === 'on'
                  : path === 'maxAutoRunsPerPr'
                    ? Number(next)
                    : next
          })
        }
      >
        <SelectTrigger className="w-44" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {repo && <SelectItem value="inherit">Use global default</SelectItem>}
          {choices.map(([key, text]) => (
            <SelectItem key={key} value={key}>
              {text}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
  return (
    <section className="space-y-4 border-t border-border/40 pt-4">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Label>Follow up on pull requests automatically</Label>
          <p className="text-xs text-muted-foreground">
            Starts the Fix failing checks agent in the PR’s workspace using its saved agent, model
            and surface.
          </p>
        </div>
        {!repo && (
          <Switch
            aria-label="Automatic PR follow-ups"
            checked={resolved.enabled}
            disabled={saving || paired}
            onCheckedChange={(value) => void write({ path: 'enabled', value })}
          />
        )}
      </div>
      {paired && <p className="text-xs text-muted-foreground">Not available on this server</p>}
      {repo &&
        select(
          'Automatic follow-ups',
          raw?.enabled === undefined ? 'inherit' : raw.enabled ? 'on' : 'off',
          'enabled',
          [
            ['on', 'On'],
            ['off', 'Off']
          ]
        )}
      {select(
        'Checks fail',
        repo && raw?.events?.ciFailed === undefined ? 'inherit' : resolved.ciFailed,
        'events.ciFailed',
        [
          ['new-agent', 'Start an agent'],
          ['off', 'Nothing']
        ]
      )}
      {['Checks pass', 'Merged'].map((label) => (
        <div
          key={label}
          className="flex items-center justify-between gap-4 text-sm text-muted-foreground"
        >
          <span>{label}</span>
          <span>Nothing</span>
        </div>
      ))}
      {select(
        'Automatic agents per PR',
        repo && raw?.maxAutoRunsPerPr === undefined ? 'inherit' : String(resolved.maxAutoRunsPerPr),
        'maxAutoRunsPerPr',
        [
          ['1', '1'],
          ['2', '2'],
          ['3', '3']
        ]
      )}
      <p className="text-xs text-muted-foreground">
        A new push resets the count when no automatic agent may still be running. At most six agents
        start in 24 hours.
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
