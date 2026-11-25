import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  getDefaultWorkspaceCleanupRules,
  hasEnabledWorkspaceCleanupRule
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import { matchesSettingsSearch } from '../search/settings-search'
import { SettingsHostScopeUnavailableNotice } from '../host-scope/SettingsHostScopePicker'
import type { SettingsHostScope } from '../host-scope/settings-host-scope'
import { useWorkspaceCleanupHostRules } from './use-workspace-cleanup-host-rules'
import { useWorkspaceCleanupHostActivity } from './use-workspace-cleanup-host-activity'
import { useWorkspaceCleanupRuleChange } from './use-workspace-cleanup-rule-change'
import { WorkspaceCleanupAutomaticSection } from './workspace-cleanup-automatic-section'
import { WorkspaceCleanupManualSection } from './workspace-cleanup-manual-section'
import { WorkspaceCleanupActivitySection } from './workspace-cleanup-activity-section'
import { WorkspaceCleanupProtectionSection } from './workspace-cleanup-protection-section'
import { summarizeMatches } from './workspace-cleanup-preview-matches'
import {
  WorkspaceCleanupRuleRows,
  type WorkspaceCleanupRulePhase
} from './workspace-cleanup-rule-rows'
import { setWorkspaceCleanupRuleEnabled } from './workspace-cleanup-rule-keys'
import { WorkspaceCleanupRuleChangeDialog } from './workspace-cleanup-rule-change-dialog'
import { getWorkspaceCleanupSettingsSearchParts } from './workspace-cleanup-settings-search'
import { useWorkspaceCleanupHostName } from './use-workspace-cleanup-host-name'

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
  const host = useWorkspaceCleanupHostName(owner, settings?.machineName)
  const query = useAppStateValue((state) => state.settingsSearchQuery)
  const { hostRules, reload } = useWorkspaceCleanupHostRules(owner, settings, updateSettings)
  const change = useWorkspaceCleanupRuleChange({
    owner,
    onSavedPreview: (savedRules, next) => adoptPreview(savedRules, next)
  })
  const rules =
    owner.kind === 'local' && hostRules.state === 'ready'
      ? hostRules.rules
      : (change.read?.state.rules ??
        (hostRules.state === 'ready' ? hostRules.rules : getDefaultWorkspaceCleanupRules()))
  const { hostReport, preview, cleaningUp, cleanUpNow, adoptPreview } =
    useWorkspaceCleanupHostActivity(owner, rules)
  const matches = useMemo(() => summarizeMatches(preview), [preview])
  const search = getWorkspaceCleanupSettingsSearchParts()
  if (!hostScope.available) {
    return <SettingsHostScopeUnavailableNotice />
  }
  if (hostRules.state === 'error') {
    return (
      <p className="px-1 text-sm text-muted-foreground">
        {t(
          'components.settings.workspaceCleanup.rulesLoadFailed',
          "Couldn't load this host's cleanup rules: {{error}}",
          { error: hostRules.message }
        )}{' '}
        <button type="button" onClick={reload} className="underline">
          {t('components.settings.workspaceCleanup.retry', 'Try again')}
        </button>
      </p>
    )
  }
  const ruleKey =
    change.errorSetting === 'mode' || change.errorSetting === 'keepIgnoredFiles'
      ? null
      : change.errorSetting
  const phase: WorkspaceCleanupRulePhase =
    change.checking && change.enabling ? 'checking' : change.enabling ? 'enabling' : 'saving'
  const report = hostReport.state === 'ready' ? hostReport.report : null
  const errorLine =
    change.error && !change.pending ? (
      <p role="alert" className="text-xs text-muted-foreground">
        {change.error}{' '}
        <button type="button" className="underline" onClick={change.retry}>
          {t('components.settings.workspaceCleanup.retry', 'Try again')}
        </button>
      </p>
    ) : null
  return (
    <div
      onFocusCapture={(event) => {
        if (event.target instanceof HTMLElement) {
          change.rememberControl(event.target)
        }
      }}
    >
      {matchesSettingsSearch(query, [search.review]) ? <WorkspaceCleanupManualSection /> : null}
      <WorkspaceCleanupAutomaticSection
        anyRuleOn={hasEnabledWorkspaceCleanupRule(rules) || Boolean(report?.nextRunAt)}
        report={report}
        readAt={hostReport.state === 'ready' ? hostReport.readAt : 0}
        cleaningUp={cleaningUp}
        onCleanUpNow={() => void cleanUpNow()}
        showRules={matchesSettingsSearch(query, [
          search.merged,
          search.unchanged,
          search.inactive,
          search.automationRuns,
          search.orchestrationWorkers
        ])}
      >
        {change.capability === 'old' || hostRules.state === 'unsupported' ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'components.settings.workspaceCleanup.change.oldGlobal',
              'Update Orca on {{host}} to change cleanup rules.',
              { host }
            )}
          </p>
        ) : null}
        {!ruleKey && change.errorSetting !== 'keepIgnoredFiles' ? errorLine : null}
        <WorkspaceCleanupRuleRows
          rules={rules}
          matches={matches}
          inactiveDraftKey={change.unsavedChanges}
          disabled={change.capability !== 'ready'}
          operation={{
            pending: ruleKey && (change.checking || change.saving) ? { key: ruleKey, phase } : null,
            failedKey: change.failedCheck ? ruleKey : null,
            returnTargetKey: ruleKey,
            busy: change.guarded,
            onRetry: change.retry
          }}
          error={
            change.error && !change.pending && ruleKey && !change.failedCheck
              ? { key: ruleKey, message: change.error, retry: change.retry }
              : undefined
          }
          onToggle={(key) => {
            const enabled = !rules[key].enabled
            change.requestChange({
              setting: key,
              kind: enabled ? 'enable' : 'change',
              changeRules: (latest) => setWorkspaceCleanupRuleEnabled(latest, key, enabled)
            })
          }}
          onChange={(update) =>
            change.requestChange({ setting: 'inactive', kind: 'change', changeRules: update })
          }
        />
      </WorkspaceCleanupAutomaticSection>
      {matchesSettingsSearch(query, [search.keepIgnoredFiles]) ? (
        <>
          <WorkspaceCleanupProtectionSection
            keepIgnoredFiles={rules.keepWhen === 'any-local-files'}
            disabled={change.guarded}
            onToggleKeepIgnoredFiles={() => {
              const keepIgnored = rules.keepWhen !== 'any-local-files'
              change.requestChange({
                setting: 'keepIgnoredFiles',
                kind: keepIgnored ? 'change' : 'disable-ignored-files',
                changeRules: (latest) => ({
                  ...latest,
                  keepWhen: keepIgnored ? 'any-local-files' : 'uncommitted'
                })
              })
            }}
          />
          {change.errorSetting === 'keepIgnoredFiles' ? errorLine : null}
        </>
      ) : null}
      {matchesSettingsSearch(query, [search.activity]) ? (
        <WorkspaceCleanupActivitySection hostReport={hostReport} />
      ) : null}
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
