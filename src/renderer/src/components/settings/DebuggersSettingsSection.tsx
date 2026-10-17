import type React from 'react'
import { useEffect, useState } from 'react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { DebugAdapterDescription } from '../../../../preload/api/debug-api'
import { debugClient, type DebugClient, type DebugClientResult } from '@/lib/debug/debug-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader, SettingsSwitchRow } from './SettingsFormControls'

type DebuggersSettingsSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  client?: Pick<DebugClient, 'describeAdapters'>
}

type AdapterListing = DebugClientResult<DebugAdapterDescription[]>
type ApprovalTable = Record<string, string[]>

function withValue(table: ApprovalTable, repoId: string, value: string, add: boolean) {
  const current = table[repoId] ?? []
  const next = add ? [...new Set([...current, value])] : current.filter((v) => v !== value)
  const { [repoId]: _previous, ...others } = table
  return next.length > 0 ? { ...others, [repoId]: next } : others
}

/** Approval keys are JSON [adapterId, binary, ...args]; show what a stale key would have run. */
function describeApprovalKey(key: string): string {
  try {
    const parsed: unknown = JSON.parse(key)
    return Array.isArray(parsed) ? parsed.map(String).join(' ') : key
  } catch {
    return key
  }
}

function PathSetting({
  title,
  description,
  value,
  placeholder,
  keywords,
  onCommit
}: {
  title: string
  description: string
  value: string
  placeholder: string
  keywords: string[]
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = (): void => {
    if (draft.trim() !== value) {
      onCommit(draft.trim())
    }
  }
  return (
    <SearchableSetting title={title} keywords={keywords}>
      <div className="space-y-1 py-2">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
        <Input
          aria-label={title}
          placeholder={placeholder}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => event.key === 'Enter' && commit()}
        />
      </div>
    </SearchableSetting>
  )
}

function AdapterRows({
  repo,
  listing,
  approvedKeys,
  setApproved
}: {
  repo: Repo
  listing: AdapterListing | undefined
  approvedKeys: string[]
  setApproved: (key: string, approved: boolean) => void
}): React.JSX.Element {
  if (!listing) {
    return (
      <div className="text-xs text-muted-foreground">
        {translate('debug.settings.discovering', 'Looking for installed debug adapters…')}
      </div>
    )
  }
  if (!listing.ok) {
    return (
      <div role="alert" className="text-xs break-words text-destructive">
        {listing.message}
      </div>
    )
  }
  if (listing.value.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        {translate('debug.settings.noAdapters', 'No debug adapters found for this project.')}
      </div>
    )
  }
  const currentKeys = listing.value.flatMap((adapter) => adapter.approvalKey ?? [])
  const staleKeys = approvedKeys.filter((key) => !currentKeys.includes(key))
  const approveLabel = (approved: boolean): string =>
    approved
      ? translate('debug.settings.revoke', 'Revoke')
      : translate('debug.settings.approve', 'Approve')
  return (
    <div className="space-y-2">
      {listing.value.map((adapter) => {
        const key = adapter.approvalKey
        const approved = key !== null && approvedKeys.includes(key)
        return (
          <div key={adapter.adapterId} className="flex items-center justify-between gap-4 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {adapter.label} ({adapter.languages.join(', ')})
              </div>
              {adapter.binaryPath ? (
                <div className="break-all font-mono text-xs text-muted-foreground">
                  {[adapter.binaryPath, ...(adapter.args ?? [])].join(' ')}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">
                  {adapter.hint ?? translate('debug.settings.notFound', 'Not found')}
                </div>
              )}
              {adapter.repoLocal ? (
                <div className="text-xs text-destructive">
                  {translate(
                    'debug.settings.repoLocal',
                    'This binary is inside {{project}}; anything that writes the repository can change what runs.',
                    { project: repo.displayName }
                  )}
                </div>
              ) : null}
            </div>
            {key ? (
              <Button
                size="sm"
                variant="outline"
                aria-label={`${approveLabel(approved)} ${adapter.label}`}
                onClick={() => setApproved(key, !approved)}
              >
                {approveLabel(approved)}
              </Button>
            ) : null}
          </div>
        )
      })}
      {staleKeys.map((key) => (
        <div key={key} className="flex items-center justify-between gap-4 text-sm">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted-foreground">
              {translate('debug.settings.staleApproval', 'Approved earlier, no longer found')}
            </div>
            <div className="break-all font-mono text-xs text-muted-foreground">
              {describeApprovalKey(key)}
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setApproved(key, false)}>
            {approveLabel(true)}
          </Button>
        </div>
      ))}
    </div>
  )
}

export function DebuggersSettingsSection({
  settings,
  updateSettings,
  client = debugClient
}: DebuggersSettingsSectionProps): React.JSX.Element {
  const repos = useAppStore((state) => state.repos) ?? []
  const enabledRepos = settings.debugEnabledRepos ?? []
  const adapterApprovals = settings.debugAdapterApprovals ?? {}
  const launchApprovals = settings.debugLaunchApprovals ?? {}
  const [listings, setListings] = useState<Record<string, AdapterListing>>({})
  const enabledKey = repos
    .filter((repo) => enabledRepos.includes(repo.id))
    .map((repo) => `${repo.id}\u0000${repo.path}`)
    .join('\u0001')

  // Why keyed on the path settings: they change which binary, and so which approval key, main resolves.
  useEffect(() => {
    let current = true
    setListings({})
    for (const entry of enabledKey ? enabledKey.split('\u0001') : []) {
      const [repoId, worktreePath] = entry.split('\u0000')
      const settle = (listing: AdapterListing): void => {
        if (current) {
          setListings((previous) => ({ ...previous, [repoId]: listing }))
        }
      }
      client
        .describeAdapters({ repoId, worktreePath })
        .then(settle)
        .catch((error: unknown) =>
          settle({
            ok: false,
            reason: 'request-failed',
            message: error instanceof Error ? error.message : String(error)
          })
        )
    }
    return () => {
      current = false
    }
  }, [client, enabledKey, settings.debugPythonPath, settings.debugJsDebugServerPath])

  const setRepoEnabled = (repoId: string, enabled: boolean): void => {
    const others = enabledRepos.filter((id) => id !== repoId)
    updateSettings({ debugEnabledRepos: enabled ? [...others, repoId] : others })
  }

  return (
    <section key="debuggers" className="space-y-4">
      <SettingsSubsectionHeader
        title={translate('debug.settings.title', 'Debuggers')}
        description={translate(
          'debug.settings.description',
          'Debug adapters run only for projects you allow, from binaries you approve.'
        )}
      />
      {repos.map((repo) => {
        const enabled = enabledRepos.includes(repo.id)
        const launches = launchApprovals[repo.id] ?? []
        return (
          <SearchableSetting
            key={repo.id}
            title={repo.displayName}
            keywords={['debug', 'debugger', 'debuggers', 'dap', 'trust', 'adapter']}
          >
            <SettingsSwitchRow
              label={repo.displayName}
              description={translate('debug.settings.allowDebugging', 'Allow debugging')}
              ariaLabel={translate(
                'debug.settings.allowDebuggingFor',
                'Allow debugging {{project}}',
                {
                  project: repo.displayName
                }
              )}
              checked={enabled}
              onChange={() => setRepoEnabled(repo.id, !enabled)}
            />
            {enabled ? (
              <div className="space-y-3 pb-2 pl-3">
                <AdapterRows
                  repo={repo}
                  listing={listings[repo.id]}
                  approvedKeys={adapterApprovals[repo.id] ?? []}
                  setApproved={(key, approved) =>
                    updateSettings({
                      debugAdapterApprovals: withValue(adapterApprovals, repo.id, key, approved)
                    })
                  }
                />
              </div>
            ) : null}
            {launches.length > 0 ? (
              <div className="space-y-1 pb-2 pl-3">
                <div className="text-xs font-medium">
                  {translate('debug.settings.launchApprovals', 'Approved Launch Configurations')}
                </div>
                {launches.map((hash) => (
                  <div key={hash} className="flex items-center justify-between gap-4">
                    <span className="truncate font-mono text-xs text-muted-foreground" title={hash}>
                      {hash}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={`${translate('debug.settings.revoke', 'Revoke')} ${hash}`}
                      onClick={() =>
                        updateSettings({
                          debugLaunchApprovals: withValue(launchApprovals, repo.id, hash, false)
                        })
                      }
                    >
                      {translate('debug.settings.revoke', 'Revoke')}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
          </SearchableSetting>
        )
      })}
      <PathSetting
        title={translate('debug.settings.pythonPath', 'Python for debugpy')}
        description={translate(
          'debug.settings.pythonPathDescription',
          'Interpreter that runs debugpy when a launch configuration names none. Leave empty to detect it.'
        )}
        value={settings.debugPythonPath ?? ''}
        placeholder={translate('debug.settings.pythonPathPlaceholder', 'python3')}
        keywords={['python', 'debugpy', 'interpreter']}
        onCommit={(value) => updateSettings({ debugPythonPath: value })}
      />
      <PathSetting
        title={translate('debug.settings.jsDebugPath', 'js-debug Server')}
        description={translate(
          'debug.settings.jsDebugPathDescription',
          'Path to js-debug’s dapDebugServer.js. Leave empty to use the default install location.'
        )}
        value={settings.debugJsDebugServerPath ?? ''}
        placeholder={translate('debug.settings.jsDebugPathPlaceholder', 'dapDebugServer.js')}
        keywords={['javascript', 'node', 'js-debug']}
        onCommit={(value) => updateSettings({ debugJsDebugServerPath: value })}
      />
    </section>
  )
}
