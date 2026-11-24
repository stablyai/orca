import { useWorkspaceCleanupRuleChange } from '../../workspace-cleanup/use-workspace-cleanup-rule-change'
import { WorkspaceCleanupRuleChangeDialog } from '../../workspace-cleanup/workspace-cleanup-rule-change-dialog'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  getDefaultWorkspaceCleanupRules,
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
import { isFolderRepo } from '../../../../../../shared/repository/repo-kind'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { matchesSettingsSearch } from '../../search/settings-search'
import { useWorkspaceCleanupHostName } from '../../workspace-cleanup/use-workspace-cleanup-host-name'

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
  const ownerTarget = ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo))
  const owner = ownerTarget ?? { kind: 'local' as const }
  const host = useWorkspaceCleanupHostName(owner, settings?.machineName)
  const { hostRules } = useWorkspaceCleanupHostRules(owner, settings, updateSettings)
  const change = useWorkspaceCleanupRuleChange({
    owner,
    repoId: repo.id,
    projectName: repo.displayName,
    legacyOff:
      hostRules.state === 'ready'
        ? () => updateRepo(repo.id, { workspaceCleanupPolicy: { mode: 'off' } })
        : undefined
  })
  const entry = getRepositoryWorkspaceCleanupSearchEntry(repo, t)
  // Cleanup never removes a folder project's workspace, and a paired browser reads its own
  // settings rather than the global rules of the host it pairs with.
  if (
    !ownerTarget ||
    hostRules.state === 'loading' ||
    isFolderRepo(repo) ||
    isWebClientLocation() ||
    !(forceVisible || matchesSettingsSearch(searchQuery, entry))
  ) {
    return null
  }
  const globalRules =
    change.read?.state.rules ??
    (hostRules.state === 'ready' ? hostRules.rules : getDefaultWorkspaceCleanupRules())
  const policy = change.read
    ? (change.read.state.projects[0]?.policy ?? undefined)
    : repo.workspaceCleanupPolicy
  const choice: PolicyChoice = policy?.mode ?? 'global'
  const globalSummary = formatWorkspaceCleanupRuleSummary(globalRules, t)

  const choose = (next: string): void => {
    if (next === choice || change.checking || change.saving || change.pending) {
      return
    }
    if (next !== 'global' && next !== 'off' && next !== 'custom') {
      return
    }
    if (next === 'off' && change.capability !== 'ready' && hostRules.state !== 'ready') {
      return
    }
    change.requestChange({
      setting: 'mode',
      kind: next === 'global' ? 'inherit' : 'change',
      mode: next
    })
  }
  const oldHost = change.capability === 'old' || hostRules.state === 'unsupported'

  return (
    <div
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement) {
          change.rememberControl(event.target)
        }
      }}
    >
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
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {change.checking === 'mode'
                  ? t('components.settings.workspaceCleanup.rules.checking', 'Checking matches…')
                  : choice === 'global'
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
            <Select value={choice} onValueChange={choose}>
              <SelectTrigger
                aria-disabled={Boolean(change.checking || change.saving || change.pending)}
                onPointerDown={(event) => {
                  if (change.checking || change.saving || change.pending) {
                    event.preventDefault()
                  }
                }}
                onKeyDown={(event) => {
                  // Tab still moves focus; only keys that open or pick are held while it's busy.
                  if ((change.checking || change.saving || change.pending) && event.key !== 'Tab') {
                    event.preventDefault()
                  }
                }}
                size="sm"
                className="h-8 w-[132px]"
                aria-label={entry.title}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value="global"
                  aria-disabled={change.guarded}
                  onPointerDown={(event) => {
                    if (change.guarded) {
                      event.preventDefault()
                    }
                  }}
                  onKeyDown={(event) => {
                    if (change.guarded && event.key !== 'Tab') {
                      event.preventDefault()
                    }
                  }}
                >
                  {t('components.settings.repository.workspaceCleanup.useGlobal', 'Use global')}
                </SelectItem>
                <SelectItem
                  value="off"
                  aria-disabled={change.capability !== 'ready' && hostRules.state !== 'ready'}
                >
                  {t('components.settings.repository.workspaceCleanup.off', 'Off')}
                </SelectItem>
                <SelectItem
                  value="custom"
                  aria-disabled={change.guarded}
                  onPointerDown={(event) => {
                    if (change.guarded) {
                      event.preventDefault()
                    }
                  }}
                  onKeyDown={(event) => {
                    if (change.guarded && event.key !== 'Tab') {
                      event.preventDefault()
                    }
                  }}
                >
                  {t('components.settings.repository.workspaceCleanup.custom', 'Custom')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {oldHost ? (
            <p className="text-xs text-muted-foreground">
              {hostRules.state === 'ready'
                ? t(
                    'components.settings.workspaceCleanup.change.oldProject',
                    'Update Orca on {{host}} to change rules. Off still works.',
                    { host }
                  )
                : t(
                    'components.settings.workspaceCleanup.change.oldProjectUnsupported',
                    'Update Orca on {{host}} to change cleanup here.',
                    { host }
                  )}
            </p>
          ) : null}
          {change.error &&
          !change.pending &&
          (!change.errorSetting || change.errorSetting === 'mode') ? (
            <p role="alert" className="mb-3 text-xs text-destructive">
              {change.error}{' '}
              <button type="button" className="underline" onClick={change.retry}>
                {t('components.settings.workspaceCleanup.retry', 'Try again')}
              </button>
            </p>
          ) : null}
          {policy?.mode === 'custom' ? (
            <div className="ml-4 border-l border-border pl-4">
              <WorkspaceCleanupRuleRows
                inactiveDraftKey={change.unsavedChanges}
                rules={policy.rules}
                forceVisible
                disabled={change.guarded}
                pendingRule={
                  change.checking === 'mode' || change.checking === 'keepIgnoredFiles'
                    ? null
                    : change.checking
                }
                error={
                  change.error &&
                  !change.pending &&
                  change.errorSetting &&
                  change.errorSetting !== 'mode' &&
                  change.errorSetting !== 'keepIgnoredFiles'
                    ? { key: change.errorSetting, message: change.error, retry: change.retry }
                    : undefined
                }
                onToggle={(key) =>
                  change.requestChange({
                    setting: key,
                    kind: policy.rules[key].enabled ? 'change' : 'enable',
                    changeRules: (latest) =>
                      setWorkspaceCleanupRuleEnabled(latest, key, !policy.rules[key].enabled)
                  })
                }
                onChange={(update) =>
                  change.requestChange({
                    setting: 'inactive',
                    kind: 'change',
                    changeRules: update
                  })
                }
              />
            </div>
          ) : null}
        </SearchableSetting>
      </SettingsGroup>
      <WorkspaceCleanupRuleChangeDialog
        request={change.pending}
        onCancel={change.cancel}
        onConfirm={change.confirm}
        onToggleKeep={change.toggleKeep}
        confirming={change.saving}
        settling={change.settling}
        disconnected={change.disconnected}
        pinFailure={change.pinFailure}
        error={change.error}
        onRetry={change.retry}
        onCloseAutoFocus={change.returnFocus}
      />
    </div>
  )
}
