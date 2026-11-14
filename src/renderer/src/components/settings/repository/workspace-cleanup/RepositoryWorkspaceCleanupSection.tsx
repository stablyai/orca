import { useState } from 'react'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  withEveryRuleOff,
  type RepoWorkspaceCleanupPolicy
} from '../../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { useWorkspaceCleanupHostRules } from '../../workspace-cleanup/use-workspace-cleanup-host-rules'
import { WorkspaceCleanupRuleRows } from '../../workspace-cleanup/workspace-cleanup-rule-rows'
import { setWorkspaceCleanupRuleEnabled } from '../../workspace-cleanup/workspace-cleanup-rule-keys'
import { formatWorkspaceCleanupRuleSummary } from '../../workspace-cleanup/workspace-cleanup-rule-summary'
import { getRepositoryWorkspaceCleanupSearchEntry } from './repository-workspace-cleanup-search'
import { isFolderRepo } from '../../../../../../shared/repo-kind'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { matchesSettingsSearch } from '../../search/settings-search'

type PolicyChoice = 'global' | RepoWorkspaceCleanupPolicy['mode']

/** A project's own cleanup rules; absent follows the rules of the host that owns the project. */
export function RepositoryWorkspaceCleanupSection({
  repo,
  updateRepo,
  forceVisible
}: {
  repo: Repo
  updateRepo: (
    repoId: string,
    updates: { workspaceCleanupPolicy: RepoWorkspaceCleanupPolicy | null }
  ) => void | Promise<boolean>
  forceVisible: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const owner = ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo)) ?? { kind: 'local' }
  const { hostRules } = useWorkspaceCleanupHostRules(owner, settings, updateSettings)
  // Each write replaces the whole policy, so a second edit must wait for the first to land.
  const [saving, setSaving] = useState(false)
  const entry = getRepositoryWorkspaceCleanupSearchEntry(repo, t)
  // Cleanup never removes a folder project's workspace, and a paired browser reads its own
  // settings rather than the global rules of the host it pairs with.
  if (
    hostRules.state !== 'ready' ||
    isFolderRepo(repo) ||
    isWebClientLocation() ||
    !(forceVisible || matchesSettingsSearch(searchQuery, entry))
  ) {
    return null
  }
  const globalRules = hostRules.rules
  const policy = repo.workspaceCleanupPolicy
  const choice: PolicyChoice = policy?.mode ?? 'global'
  const globalSummary = formatWorkspaceCleanupRuleSummary(globalRules, t)

  const save = (workspaceCleanupPolicy: RepoWorkspaceCleanupPolicy | null): void => {
    setSaving(true)
    void Promise.resolve(updateRepo(repo.id, { workspaceCleanupPolicy })).finally(() =>
      setSaving(false)
    )
  }

  const choose = (next: string): void => {
    if (next === choice) {
      return
    }
    save(
      next === 'off'
        ? { mode: 'off' }
        : next === 'custom'
          ? // Custom starts from what the project followed, so switching changes nothing yet.
            {
              mode: 'custom',
              rules: choice === 'off' ? withEveryRuleOff(globalRules) : globalRules
            }
          : null
    )
  }

  return (
    <SettingsGroup
      title={t('components.settings.repository.workspaceCleanup.title', 'Workspace cleanup')}
      description={t(
        'components.settings.repository.workspaceCleanup.description',
        'Rules for {{name}} only. Use global follows Settings / Workspace Cleanup.',
        { name: repo.displayName }
      )}
    >
      <SearchableSetting {...entry} className="space-y-2 py-3" forceVisible={forceVisible}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold">{entry.title}</p>
            <p className="text-xs text-muted-foreground">
              {choice === 'global'
                ? t(
                    'components.settings.repository.workspaceCleanup.usingGlobal',
                    'Using global: {{rules}}',
                    { rules: globalSummary }
                  )
                : t(
                    'components.settings.repository.workspaceCleanup.globalDefault',
                    'Global default: {{rules}}',
                    { rules: globalSummary }
                  )}
            </p>
          </div>
          <Select value={choice} onValueChange={choose} disabled={saving}>
            <SelectTrigger size="sm" className="h-8 w-[132px]" aria-label={entry.title}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">
                {t('components.settings.repository.workspaceCleanup.useGlobal', 'Use global')}
              </SelectItem>
              <SelectItem value="off">
                {t('components.settings.repository.workspaceCleanup.off', 'Off')}
              </SelectItem>
              <SelectItem value="custom">
                {t('components.settings.repository.workspaceCleanup.custom', 'Custom')}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        {policy?.mode === 'custom' ? (
          <div className="ml-4 border-l border-border pl-4">
            <WorkspaceCleanupRuleRows
              rules={policy.rules}
              forceVisible
              disabled={saving}
              onToggle={(key) =>
                save({
                  mode: 'custom',
                  rules: setWorkspaceCleanupRuleEnabled(
                    policy.rules,
                    key,
                    !policy.rules[key].enabled
                  )
                })
              }
              onChange={(change) => save({ mode: 'custom', rules: change(policy.rules) })}
            />
          </div>
        ) : null}
      </SearchableSetting>
    </SettingsGroup>
  )
}
