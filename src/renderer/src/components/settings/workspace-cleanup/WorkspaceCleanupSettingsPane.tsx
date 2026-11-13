import { useEffect, useMemo, useRef, useState } from 'react'
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
  setWorkspaceCleanupRuleEnabled,
  type WorkspaceCleanupRuleKey
} from './workspace-cleanup-rule-keys'
import {
  WorkspaceCleanupRuleChangeDialog,
  type WorkspaceCleanupRuleChangeRequest
} from './workspace-cleanup-rule-change-dialog'
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

function previewRowKey(row: WorkspaceCleanupPreviewRow): string {
  return `${row.executionHostId ?? ''}:${row.worktreeId}`
}

/** Workspaces `next` would remove now that `current` would not. */
function newRemovals(
  next: WorkspaceCleanupPreview,
  current: WorkspaceCleanupPreview | null
): WorkspaceCleanupPreviewRow[] {
  const removedNow = new Set(
    (current?.rows ?? []).filter((row) => row.evaluation.action !== 'keep').map(previewRowKey)
  )
  return next.rows.filter(
    (row) => row.evaluation.action !== 'keep' && !removedNow.has(previewRowKey(row))
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

type RulesChange = (rules: WorkspaceCleanupRules) => WorkspaceCleanupRules

type PendingChange = WorkspaceCleanupRuleChangeRequest & { change: RulesChange }

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
  const { hostRules, readLatest, reload, update } = useWorkspaceCleanupHostRules(
    owner,
    settings,
    updateSettings
  )
  const rules = hostRules.state === 'ready' ? hostRules.rules : null
  const { hostReport, preview, cleaningUp, cleanUpNow, previewRules } =
    useWorkspaceCleanupHostActivity(owner, rules)
  const matches = useMemo(() => summarizeMatches(preview), [preview])
  const [pendingRule, setPendingRule] = useState<WorkspaceCleanupRuleKey | null>(null)
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null)
  // One change at a time: a second one built while the first previews would start from stale rules.
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  // A change still previewing when the pane unmounts must not write over what came after it.
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  // Remounts the rows after a change that was not saved, so an edited field shows the saved value.
  const [unsavedChanges, setUnsavedChanges] = useState(0)
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
  if (hostRules.state === 'error') {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        {t(
          'components.settings.workspaceCleanup.rulesLoadFailed',
          "Couldn't load this host's cleanup rules: {{error}}",
          { error: hostRules.message }
        )}{' '}
        <button
          type="button"
          onClick={reload}
          className="underline decoration-muted-foreground/50 underline-offset-4 hover:text-foreground"
        >
          {t('components.settings.workspaceCleanup.retry', 'Try again')}
        </button>
      </p>
    )
  }
  if (!rules) {
    return null
  }
  const currentRules = rules

  const finishChange = (saved: boolean): void => {
    busyRef.current = false
    setBusy(false)
    setPendingRule(null)
    if (!saved) {
      setUnsavedChanges((count) => count + 1)
    }
  }

  /**
   * The runner acts within seconds of a rule change, so a change that would delete more asks first.
   * `request` is null for a change that can only delete less, such as turning a rule off.
   */
  const applyRules = async (
    change: RulesChange,
    request: Omit<WorkspaceCleanupRuleChangeRequest, 'rows'> | null,
    pendingKey: WorkspaceCleanupRuleKey | null = null
  ): Promise<void> => {
    if (busyRef.current) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setPendingRule(pendingKey)
    // Another client may have changed the rules since this page read them.
    const latest = await readLatest()
    if (!mountedRef.current) {
      return
    }
    if (!latest) {
      finishChange(false)
      return
    }
    const nextRules = change(latest)
    let rows: WorkspaceCleanupPreviewRow[] = []
    if (request && hasEnabledWorkspaceCleanupRule(nextRules)) {
      // Project rules can delete with every global rule off, so the current rules are always read.
      const previews = await Promise.all([previewRules(nextRules), previewRules(latest)]).catch(
        (error: unknown) => {
          toast.error(
            t(
              'components.settings.workspaceCleanup.previewFailed',
              "Couldn't check which workspaces this change matches."
            ),
            { description: errorMessage(error) }
          )
          return null
        }
      )
      if (!mountedRef.current) {
        return
      }
      if (!previews) {
        finishChange(false)
        return
      }
      rows = newRemovals(previews[0], previews[1])
    }
    if (request && rows.length > 0) {
      setPendingRule(null)
      setPendingChange({ ...request, rows, change })
      return
    }
    finishChange(await update(nextRules))
  }

  const toggleRule = (key: WorkspaceCleanupRuleKey): void => {
    const enabled = !currentRules[key].enabled
    void applyRules(
      (latest) => setWorkspaceCleanupRuleEnabled(latest, key, enabled),
      enabled ? { kind: 'enable', ruleTitle: search[key].title } : null,
      key
    )
  }

  const cancelChange = (): void => {
    setPendingChange(null)
    finishChange(false)
  }

  const confirmChange = async (keep: WorkspaceCleanupPreviewRow[]): Promise<void> => {
    const change = pendingChange
    if (!change) {
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
    // The dialog can stay open a while; apply the change to the rules as they are now.
    const latest = await readLatest()
    if (!latest || !mountedRef.current) {
      return
    }
    if (await update(change.change(latest))) {
      setPendingChange(null)
      finishChange(true)
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
        // A project's own rules can keep the runner scheduled while every global rule is off.
        anyRuleOn={hasEnabledWorkspaceCleanupRule(currentRules) || Boolean(report?.nextRunAt)}
        report={report}
        readAt={hostReport.state === 'ready' ? hostReport.readAt : 0}
        cleaningUp={cleaningUp}
        onCleanUpNow={() => void cleanUpNow()}
      />
      {showRules ? (
        <div className="space-y-3">
          <SettingsGroup title={t('components.settings.workspaceCleanup.rules.title', 'Rules')}>
            <WorkspaceCleanupRuleRows
              key={unsavedChanges}
              rules={currentRules}
              matches={matches}
              pendingRule={pendingRule}
              disabled={busy}
              onToggle={toggleRule}
              onChange={(change) =>
                void applyRules(
                  change,
                  { kind: 'change', ruleTitle: search.inactive.title },
                  'inactive'
                )
              }
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
              disabled={busy}
              onChange={() => {
                const keepIgnored = currentRules.keepWhen !== 'any-local-files'
                void applyRules(
                  (latest) => ({
                    ...latest,
                    keepWhen: keepIgnored ? 'any-local-files' : 'uncommitted'
                  }),
                  // Keeping more can only delete less; letting ignored files go asks first.
                  keepIgnored ? null : { kind: 'change', ruleTitle: search.keepIgnoredFiles.title }
                )
              }}
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
      <WorkspaceCleanupRuleChangeDialog
        request={pendingChange}
        onCancel={cancelChange}
        onConfirm={confirmChange}
      />
    </>
  )
}
