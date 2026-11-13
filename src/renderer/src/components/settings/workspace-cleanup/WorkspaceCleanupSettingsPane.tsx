import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { errorMessage } from '../../../../../shared/error-message'
import {
  WORKSPACE_CLEANUP_RULE_KEYS,
  hasEnabledWorkspaceCleanupRule,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type {
  WorkspaceCleanupPreview,
  WorkspaceCleanupPreviewRow
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { matchesSettingsSearch } from '../search/settings-search'
import { SettingsHostScopeUnavailableNotice } from '../host-scope/SettingsHostScopePicker'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { useWorkspaceCleanupHostRules } from './use-workspace-cleanup-host-rules'
import { useWorkspaceCleanupHostActivity } from './use-workspace-cleanup-host-activity'
import { WorkspaceCleanupSettingsStatus } from './workspace-cleanup-settings-status'
import {
  WorkspaceCleanupRuleRows,
  type WorkspaceCleanupRuleMatches
} from './workspace-cleanup-rule-rows'
import {
  WORKSPACE_CLEANUP_RULE_REASON,
  toggleWorkspaceCleanupRule,
  type WorkspaceCleanupRuleKey
} from './workspace-cleanup-rule-keys'
import {
  WorkspaceCleanupEnableRuleDialog,
  type WorkspaceCleanupEnableRuleRequest
} from './workspace-cleanup-enable-rule-dialog'
import { WorkspaceCleanupActivityList } from './workspace-cleanup-activity-list'
import { getWorkspaceCleanupSettingsSearchParts } from './workspace-cleanup-settings-search'

function removalsFor(
  preview: WorkspaceCleanupPreview,
  key: WorkspaceCleanupRuleKey
): WorkspaceCleanupPreviewRow[] {
  const reason = WORKSPACE_CLEANUP_RULE_REASON[key]
  return preview.rows.filter(
    (row) => row.evaluation.action !== 'keep' && row.evaluation.reason === reason
  )
}

function summarizeMatches(
  preview: WorkspaceCleanupPreview | null
): Partial<Record<WorkspaceCleanupRuleKey, WorkspaceCleanupRuleMatches>> | undefined {
  if (!preview) {
    return undefined
  }
  const matches: Partial<Record<WorkspaceCleanupRuleKey, WorkspaceCleanupRuleMatches>> = {}
  for (const key of WORKSPACE_CLEANUP_RULE_KEYS) {
    const rows = removalsFor(preview, key)
    matches[key] = { rows, sizeBytes: rows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0) }
  }
  return matches
}

type PendingEnable = WorkspaceCleanupEnableRuleRequest & { nextRules: WorkspaceCleanupRules }

export function WorkspaceCleanupSettingsPane({
  hostScope,
  settings,
  updateSettings
}: {
  hostScope: SettingsHostScope
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
}): React.JSX.Element | null {
  const t = useTranslate()
  const owner = hostScope.target
  const query = useAppStateValue((state) => state.settingsSearchQuery)
  const updateWorktreeMeta = useAppStore((state) => state.updateWorktreeMeta)
  const { hostRules, update } = useWorkspaceCleanupHostRules(owner, settings, updateSettings)
  const rules = hostRules.state === 'ready' ? hostRules.rules : null
  const { hostReport, preview, cleaningUp, cleanUpNow, previewRules } =
    useWorkspaceCleanupHostActivity(owner, rules)
  const matches = useMemo(() => summarizeMatches(preview), [preview])
  const [pendingRule, setPendingRule] = useState<WorkspaceCleanupRuleKey | null>(null)
  const [pendingEnable, setPendingEnable] = useState<PendingEnable | null>(null)
  const search = getWorkspaceCleanupSettingsSearchParts()

  if (!hostScope.available) {
    return <SettingsHostScopeUnavailableNotice />
  }
  if (hostRules.state === 'unsupported' || hostReport.state === 'unsupported') {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        {t(
          'components.settings.workspaceCleanup.unsupportedHost',
          'This host runs an Orca version without automatic cleanup. Update Orca on it to use these settings.'
        )}
      </p>
    )
  }
  if (!rules) {
    return null
  }
  const currentRules = rules

  const toggleRule = async (key: WorkspaceCleanupRuleKey): Promise<void> => {
    const nextRules = toggleWorkspaceCleanupRule(currentRules, key)
    if (!nextRules[key].enabled) {
      await update(nextRules)
      return
    }
    setPendingRule(key)
    // A rule that would delete something now asks first, since the runner acts within seconds.
    const preview = await previewRules(nextRules).catch((error: unknown) => {
      toast.error(
        t(
          'components.settings.workspaceCleanup.previewFailed',
          "Couldn't check which workspaces this rule matches."
        ),
        { description: errorMessage(error) }
      )
      return null
    })
    const rows = preview ? removalsFor(preview, key) : []
    if (preview && rows.length === 0) {
      await update(nextRules)
    } else if (preview) {
      setPendingEnable({ ruleTitle: search[key].title, rows, nextRules })
    }
    setPendingRule(null)
  }

  const confirmEnable = async (keep: WorkspaceCleanupPreviewRow[]): Promise<void> => {
    if (!pendingEnable) {
      return
    }
    // Pinned workspaces are always kept, so Keep is a pin rather than a second keep list.
    for (const row of keep) {
      const result = await updateWorktreeMeta(
        row.worktreeId,
        { isPinned: true },
        {
          executionHostId:
            owner.kind === 'environment'
              ? getRuntimeTargetHostId(owner)
              : (row.executionHostId ?? LOCAL_EXECUTION_HOST_ID)
        }
      )
      if (!result.ok) {
        toast.error(
          t('components.settings.workspaceCleanup.pinFailed', "Couldn't keep {{name}}.", {
            name: row.displayName
          }),
          { description: result.error }
        )
        return
      }
    }
    if (await update(pendingEnable.nextRules)) {
      setPendingEnable(null)
    }
  }

  const hasQuery = query.trim() !== ''
  const showRules = matchesSettingsSearch(query, [
    search.merged,
    search.unchanged,
    search.inactive,
    search.automationRuns,
    search.orchestrationWorkers
  ])
  const showProtection = matchesSettingsSearch(query, [search.keepIgnoredFiles])
  const showActivity = matchesSettingsSearch(query, [search.activity])
  const report = hostReport.state === 'ready' ? hostReport.report : null

  return (
    <>
      <WorkspaceCleanupSettingsStatus
        anyRuleOn={hasEnabledWorkspaceCleanupRule(currentRules)}
        report={report}
        readAt={hostReport.state === 'ready' ? hostReport.readAt : 0}
        cleaningUp={cleaningUp}
        onCleanUpNow={() => void cleanUpNow()}
      />
      {showRules ? (
        <div className="space-y-3">
          <SettingsGroup title={t('components.settings.workspaceCleanup.rules.title', 'Rules')}>
            <WorkspaceCleanupRuleRows
              rules={currentRules}
              matches={matches}
              pendingRule={pendingRule}
              onToggle={(key) => void toggleRule(key)}
              onChange={(next) => void update(next)}
            />
          </SettingsGroup>
          {hasQuery ? null : (
            <p className="px-1 text-xs text-muted-foreground">
              {t(
                'components.settings.workspaceCleanup.rules.branchNote',
                'Merged branches are deleted with their workspace. Unmerged branches are kept.'
              )}
            </p>
          )}
        </div>
      ) : null}
      {showProtection ? (
        <SettingsGroup
          title={t('components.settings.workspaceCleanup.protection.title', 'Protection')}
          description={t(
            'components.settings.workspaceCleanup.protection.alwaysKept',
            'Always kept: pinned workspaces, running agents or terminals, unsaved editor changes, uncommitted changes, unpushed commits.'
          )}
        >
          <SearchableSetting {...search.keepIgnoredFiles}>
            <SettingsSwitchRow
              label={search.keepIgnoredFiles.title}
              description={search.keepIgnoredFiles.description}
              checked={currentRules.keepWhen === 'any-local-files'}
              onChange={() =>
                void update({
                  ...currentRules,
                  keepWhen:
                    currentRules.keepWhen === 'any-local-files' ? 'uncommitted' : 'any-local-files'
                })
              }
            />
          </SearchableSetting>
        </SettingsGroup>
      ) : null}
      {showActivity ? (
        <SettingsGroup
          title={search.activity.title}
          description={
            hostReport.state === 'error'
              ? t(
                  'components.settings.workspaceCleanup.activity.loadFailed',
                  "Couldn't load activity: {{error}}",
                  {
                    error: hostReport.message
                  }
                )
              : report && report.runs.length === 0
                ? t(
                    'components.settings.workspaceCleanup.activity.empty',
                    "Cleanup hasn't run yet."
                  )
                : undefined
          }
        >
          {report && report.runs.length > 0 ? (
            <WorkspaceCleanupActivityList runs={report.runs} />
          ) : null}
        </SettingsGroup>
      ) : null}
      <WorkspaceCleanupEnableRuleDialog
        request={pendingEnable}
        onCancel={() => setPendingEnable(null)}
        onConfirm={confirmEnable}
      />
    </>
  )
}
