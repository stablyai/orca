import { useEffect, useRef, useState } from 'react'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { SshTarget } from '../../../../../../shared/remote-runtime/ssh/ssh-types'
import {
  findSshGitExecutionTarget,
  getSshGitExecution,
  normalizeSshGitExecution,
  type SshGitExecution
} from '../../../../../../shared/remote-runtime/ssh/ssh-git-execution'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { getRepositoryGitExecutionSearchEntry } from './repository-git-execution-search'

export function RepositoryGitExecutionSection({
  repo,
  forceVisible,
  onExecutionChange
}: {
  repo: Repo
  forceVisible?: boolean
  onExecutionChange?: (execution: SshGitExecution | null) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const hostId = getRepoExecutionHostId(repo)
  const host = parseExecutionHostId(hostId)
  const supported =
    !isWebClientLocation() &&
    host?.kind !== 'local' &&
    !(host?.kind === 'runtime' && repo.connectionId)
  const [targets, setTargets] = useState<SshTarget[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const savingRef = useRef(false)

  useEffect(() => {
    if (!supported) {
      return
    }
    let cancelled = false
    void window.api.ssh.listTargets().then(
      (next) => {
        if (!cancelled) {
          setTargets(next)
        }
      },
      (cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [supported, hostId])

  const target = findSshGitExecutionTarget(targets ?? [], hostId, environments)
  const effectiveExecution = target
    ? getSshGitExecution(target, repo.path)
    : !supported || targets || error
      ? 'remote'
      : null
  useEffect(() => {
    onExecutionChange?.(effectiveExecution)
  }, [effectiveExecution, onExecutionChange])
  if (!supported || (!target && !error)) {
    return null
  }
  const entry = getRepositoryGitExecutionSearchEntry(repo, t)
  const choice = target?.gitExecutionProjects?.[repo.path] ?? 'inherit'
  const hostDefault = target?.gitExecution ?? 'remote'

  const save = async (next: string): Promise<void> => {
    const execution = normalizeSshGitExecution(next)
    if (!target || savingRef.current || next === choice || (next !== 'inherit' && !execution)) {
      return
    }
    savingRef.current = true
    setSaving(true)
    setError(null)
    try {
      const latestTargets = await window.api.ssh.listTargets()
      const latest = findSshGitExecutionTarget(latestTargets, hostId, environments)
      if (!latest || latest.id !== target.id) {
        throw new Error(
          t(
            'components.settings.repository.gitExecution.hostUnavailable',
            'The SSH host is unavailable.'
          )
        )
      }
      const projects = { ...latest.gitExecutionProjects }
      if (execution) {
        projects[repo.path] = execution
      } else {
        delete projects[repo.path]
      }
      const updated = await window.api.ssh.updateTarget({
        id: latest.id,
        updates: { gitExecutionProjects: projects }
      })
      setTargets(latestTargets.map((entry) => (entry.id === updated.id ? updated : entry)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <SearchableSetting {...entry} className="space-y-2 py-3" forceVisible={forceVisible}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-48 flex-1 space-y-1">
          <p className="text-sm font-semibold">{entry.title}</p>
          <p className="text-xs text-muted-foreground">{entry.description}</p>
        </div>
        <Select
          value={choice}
          onValueChange={(next) => void save(next)}
          disabled={saving || !target}
        >
          <SelectTrigger size="sm" className="w-full sm:w-auto" aria-label={entry.title}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">
              {t('components.settings.repository.gitExecution.inherit', 'Host default ({{host}})', {
                host:
                  hostDefault === 'local'
                    ? t('components.settings.ssh.gitExecution.local', 'This computer')
                    : t('components.settings.ssh.gitExecution.remote', 'SSH host')
              })}
            </SelectItem>
            <SelectItem value="remote">
              {t('components.settings.ssh.gitExecution.remote', 'SSH host')}
            </SelectItem>
            <SelectItem value="local">
              {t('components.settings.ssh.gitExecution.local', 'This computer')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'components.settings.repository.gitExecution.help',
          'This computer uses its own credentials for source-control and GitHub UI actions, including push. Requires the same checkout at the same absolute path. Terminals, agents, worktree management, and cloning stay on the SSH host.'
        )}
      </p>
      {effectiveExecution === 'local' ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'components.settings.repository.gitExecution.ambientCredentials',
            'Uses this computer’s Git credentials and active gh login. The SSH host’s GitHub account binding applies when using SSH execution.'
          )}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </SearchableSetting>
  )
}
