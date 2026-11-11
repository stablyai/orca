import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { BookOpenText } from 'lucide-react'
import { toast } from 'sonner'
import { InlineError } from '@/components/ui/inline-error'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import {
  setCloudAgentConfigItemIncluded,
  setCloudAgentConfigSyncPreferences,
  syncCloudAgentConfigNow,
  useCloudAgentConfigSyncPreferences,
  useCloudAgentConfigSyncStatus
} from '@/lib/cloud-agent-config-sync/cloud-agent-config-sync-client'
import { useAppStore } from '@/store'
import type { CloudAgentConfigSyncPreferences } from '../../../../../../shared/agent-config-sync/agent-config-sync-contract'
import { CloudApiEmptyState } from '../../cloud-api/cloud-api-parts'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import {
  runningOrcaCloudMcpWorkspaces,
  type OrcaCloudMcpWorkspace
} from '../OrcaCloudMcpServersPane'
import { CloudSkillsSyncPanel, CloudSkillsSyncSkeleton } from './CloudSkillsSyncPanel'

function SwitchRow({
  title,
  description,
  checked,
  disabled = false,
  onChange
}: {
  title: string
  description: string
  checked: boolean
  disabled?: boolean
  onChange: (next: boolean) => void
}): React.JSX.Element {
  const labelId = useId()
  const hintId = useId()
  return (
    <div data-settings-row="" className="flex items-start justify-between gap-4 py-4">
      <div className={cn('min-w-0 shrink space-y-0.5', disabled && 'opacity-60')}>
        <Label id={labelId}>{title}</Label>
        <p id={hintId} className="text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={hintId}
        onCheckedChange={onChange}
      />
    </div>
  )
}

export function CloudSkillsSyncSettingsView({
  preferences,
  onChange
}: {
  preferences: CloudAgentConfigSyncPreferences
  onChange: (next: Partial<Omit<CloudAgentConfigSyncPreferences, 'excluded'>>) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsGroup>
      <SwitchRow
        title={t('cloudSkillsSync.autoSync', 'Sync when a workspace starts or wakes')}
        description={t(
          'cloudSkillsSync.autoSyncHint',
          'Copies your Claude and Codex skills and slash commands into each cloud workspace. Anything that looks like a key stays on this computer, and nothing made in the sandbox is overwritten.'
        )}
        checked={preferences.autoSync}
        onChange={(autoSync) => onChange({ autoSync })}
      />
      <SwitchRow
        title={t('cloudSkillsSync.shareAcrossAgents', 'Share between Claude and Codex')}
        description={t(
          'cloudSkillsSync.shareAcrossAgentsHint',
          'In cloud workspaces, Codex also gets your Claude skills and commands, and Claude gets your Codex skills and prompts. An agent keeps its own if it has one with that name.'
        )}
        checked={preferences.shareAcrossAgents}
        // Nothing to share without sync.
        disabled={!preferences.autoSync}
        onChange={(shareAcrossAgents) => onChange({ shareAcrossAgents })}
      />
    </SettingsGroup>
  )
}

function CloudSkillsSyncSection({
  environmentId,
  excluded,
  autoSync,
  defaultExpanded
}: {
  environmentId: string
  excluded: ReadonlySet<string>
  autoSync: boolean
  defaultExpanded: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const status = useCloudAgentConfigSyncStatus(environmentId)
  const [expanded, setExpanded] = useState(defaultExpanded)
  if (status === undefined) {
    return <CloudSkillsSyncSkeleton />
  }
  if (!status) {
    return null
  }
  const syncNow = (): void => {
    void syncCloudAgentConfigNow(environmentId).catch(() =>
      toast.error(t('cloudSkillsSync.startFailed', 'Couldn’t start the sync.'))
    )
  }
  return (
    <CloudSkillsSyncPanel
      status={status}
      excluded={excluded}
      autoSync={autoSync}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((value) => !value)}
      onSyncNow={syncNow}
      onToggleItem={(key, included) => {
        // Main re-syncs every workspace that already synced; a first sync is still the user's call.
        void setCloudAgentConfigItemIncluded(key, included).catch(() =>
          toast.error(t('cloudSkillsSync.saveFailed', 'Couldn’t save the change.'))
        )
      }}
    />
  )
}

export function OrcaCloudSkillsWorkspacesView({
  workspaces,
  renderSync,
  onRetry
}: {
  workspaces: OrcaCloudMcpWorkspace[] | null | 'failed'
  renderSync: (workspace: OrcaCloudMcpWorkspace, onlyOne: boolean) => React.ReactNode
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (workspaces === 'failed') {
    return (
      <InlineError
        title={t('settings.orcaCloud.mcp.loadFailed', 'Couldn’t list your cloud workspaces')}
        retryLabel={t('cloudEnvironment.retry', 'Try again')}
        onRetry={onRetry}
      />
    )
  }
  if (workspaces === null) {
    return (
      <div aria-busy>
        <span className="sr-only">
          {t('cloudSkillsSync.loading', 'Loading skills and commands…')}
        </span>
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }
  if (workspaces.length === 0) {
    return (
      <SettingsGroup>
        <CloudApiEmptyState
          icon={BookOpenText}
          title={t('settings.orcaCloud.mcp.emptyTitle', 'No cloud workspace is running')}
          description={t(
            'cloudSkillsSync.emptyBody',
            'Skills and commands sync to a cloud workspace while it runs. Start or wake one to see what it gets.'
          )}
        />
      </SettingsGroup>
    )
  }
  return (
    <div className="space-y-3">
      {workspaces.map((workspace) => {
        const name = workspace.name ?? t('settings.orcaCloud.mcp.unnamed', 'Cloud workspace')
        return (
          <SettingsGroup key={workspace.runtimeId}>
            <section
              className="py-3"
              aria-label={t('cloudSkillsSync.workspaceLabel', 'Skills and commands in {{name}}', {
                name
              })}
            >
              <p className="truncate text-sm font-medium">{name}</p>
              {renderSync(workspace, workspaces.length === 1)}
            </section>
          </SettingsGroup>
        )
      })}
    </div>
  )
}

/** Settings › Orca Cloud › Skills & commands. */
export function OrcaCloudSkillsPane(): React.JSX.Element {
  const t = useTranslate()
  const preferences = useCloudAgentConfigSyncPreferences()
  const [workspaces, setWorkspaces] = useState<OrcaCloudMcpWorkspace[] | null | 'failed'>(null)
  const [attempt, setAttempt] = useState(0)
  const lifecycle = useAppStore((s) => s.ephemeralVmRuntimesByWorkspaceId)
  useEffect(() => {
    const listRuntimes = window.api.ephemeralVm?.listRuntimes
    if (!listRuntimes) {
      setWorkspaces([])
      return
    }
    let disposed = false
    void listRuntimes()
      .then((records) => !disposed && setWorkspaces(runningOrcaCloudMcpWorkspaces(records)))
      .catch(() => !disposed && setWorkspaces('failed'))
    return () => {
      disposed = true
    }
  }, [lifecycle, attempt])
  const retry = useCallback(() => {
    setWorkspaces(null)
    setAttempt((value) => value + 1)
  }, [])
  const excluded = useMemo(() => new Set(preferences?.excluded ?? []), [preferences])
  if (preferences === undefined) {
    return <Skeleton className="h-28 w-full" />
  }
  if (preferences === null) {
    return (
      <InlineError
        title={t('cloudSkillsSync.unavailable', 'Skill sync isn’t available in this build.')}
      />
    )
  }
  return (
    <div className="space-y-5">
      <CloudSkillsSyncSettingsView
        preferences={preferences}
        onChange={(next) =>
          void setCloudAgentConfigSyncPreferences(next).catch(() =>
            toast.error(t('cloudSkillsSync.saveFailed', 'Couldn’t save the change.'))
          )
        }
      />
      <OrcaCloudSkillsWorkspacesView
        workspaces={workspaces}
        onRetry={retry}
        renderSync={(workspace, onlyOne) => (
          <CloudSkillsSyncSection
            environmentId={workspace.environmentId}
            excluded={excluded}
            autoSync={preferences.autoSync}
            defaultExpanded={onlyOne}
          />
        )}
      />
    </div>
  )
}
