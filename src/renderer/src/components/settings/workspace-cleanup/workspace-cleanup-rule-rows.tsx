import { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { formatBytes } from '../../../../../shared/format-bytes'
import {
  WORKSPACE_ARCHIVE_SUPPORTED,
  WORKSPACE_CLEANUP_POLICY_MAX_DAYS,
  WORKSPACE_CLEANUP_POLICY_MIN_DAYS,
  type WorkspaceCleanupInactiveAction,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import {
  NumberField,
  SettingsBadge,
  SettingsRow,
  SettingsSegmentedControl
} from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroupDisclosure } from '../section-layout/SettingsGroupDisclosure'
import { matchesSettingsSearch } from '../search/settings-search'
import { Switch } from '../../ui/switch'
import { getWorkspaceCleanupSettingsSearchParts } from './workspace-cleanup-settings-search'
import { WorkspaceCleanupWorkspaceLine } from './workspace-cleanup-workspace-line'
import type { WorkspaceCleanupRuleKey } from './workspace-cleanup-rule-keys'

export type WorkspaceCleanupRuleMatches = {
  rows: WorkspaceCleanupPreviewRow[]
  sizeBytes: number
}

type RuleRowsProps = {
  rules: WorkspaceCleanupRules
  onToggle: (key: WorkspaceCleanupRuleKey) => void
  /** Gets a change as a function so it applies to the rules as they are when it is saved. */
  onChange: (change: (rules: WorkspaceCleanupRules) => WorkspaceCleanupRules) => void
  /** What each rule that is on would remove now; omitted where no preview is read. */
  matches?: Partial<Record<WorkspaceCleanupRuleKey, WorkspaceCleanupRuleMatches>>
  /** A rule whose change is waiting on a preview or a write. */
  pendingRule?: WorkspaceCleanupRuleKey | null
  /** Set while any change is in flight, so a second change cannot start from stale rules. */
  disabled?: boolean
  forceVisible?: boolean
}

/** The rule switches, shared by the Workspace Cleanup page and a project's custom rules. */
export function WorkspaceCleanupRuleRows({
  rules,
  onToggle,
  onChange,
  matches,
  pendingRule,
  disabled = false,
  forceVisible = false
}: RuleRowsProps): React.JSX.Element {
  const t = useTranslate()
  const query = useAppStateValue((state) => state.settingsSearchQuery)
  const search = getWorkspaceCleanupSettingsSearchParts()
  const advancedMatches =
    query.trim() !== '' &&
    matchesSettingsSearch(query, [search.automationRuns, search.orchestrationWorkers])

  const ruleRow = (key: WorkspaceCleanupRuleKey, description: string, badge?: string) => (
    <SearchableSetting {...search[key]} forceVisible={forceVisible}>
      <SettingsRow
        label={
          <span className="inline-flex items-center gap-2">
            {search[key].title}
            {badge ? <SettingsBadge>{badge}</SettingsBadge> : null}
          </span>
        }
        description={
          <>
            {description}
            {pendingRule === key ? (
              <span className="mt-1 block">
                {t(
                  'components.settings.workspaceCleanup.rules.checking',
                  'Checking which workspaces match…'
                )}
              </span>
            ) : matches?.[key] && rules[key].enabled ? (
              <RuleMatchesLine matches={matches[key]} />
            ) : null}
          </>
        }
        control={
          <Switch
            checked={rules[key].enabled}
            disabled={disabled}
            onCheckedChange={() => onToggle(key)}
            aria-label={search[key].title}
          />
        }
      />
      {key === 'inactive' && rules.inactive.enabled ? (
        <InactiveRuleOptions rules={rules} onChange={onChange} disabled={disabled} />
      ) : null}
    </SearchableSetting>
  )

  return (
    <>
      {ruleRow(
        'merged',
        search.merged.description,
        t('components.settings.workspaceCleanup.rules.recommended', 'Recommended')
      )}
      {ruleRow('unchanged', search.unchanged.description)}
      {ruleRow(
        'inactive',
        t(
          'components.settings.workspaceCleanup.rules.inactiveDescription',
          'No activity for {{count}} days.',
          { count: rules.inactive.afterDays, defaultValue_one: 'No activity for 1 day.' }
        )
      )}
      <SettingsGroupDisclosure
        description={t(
          'components.settings.workspaceCleanup.rules.advancedDescription',
          'Automation and orchestration worker workspaces'
        )}
        forceOpen={advancedMatches}
      >
        {ruleRow('automationRuns', search.automationRuns.description)}
        {ruleRow('orchestrationWorkers', search.orchestrationWorkers.description)}
      </SettingsGroupDisclosure>
    </>
  )
}

function InactiveRuleOptions({
  rules,
  onChange,
  disabled
}: {
  rules: WorkspaceCleanupRules
  onChange: RuleRowsProps['onChange']
  disabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const setInactive = (patch: Partial<WorkspaceCleanupRules['inactive']>): void =>
    onChange((latest) => ({ ...latest, inactive: { ...latest.inactive, ...patch } }))
  return (
    <div className="mb-2 ml-4 border-l border-border pl-4">
      <NumberField
        label={t('components.settings.workspaceCleanup.rules.inactiveFor', 'Inactive for')}
        value={rules.inactive.afterDays}
        min={WORKSPACE_CLEANUP_POLICY_MIN_DAYS}
        max={WORKSPACE_CLEANUP_POLICY_MAX_DAYS}
        integer
        suffix={t('components.settings.workspaceCleanup.rules.days', 'days')}
        disabled={disabled}
        onChange={(afterDays) => setInactive({ afterDays })}
      />
      {WORKSPACE_ARCHIVE_SUPPORTED ? (
        <SettingsRow
          label={t('components.settings.workspaceCleanup.rules.then', 'Then')}
          description={
            rules.inactive.action === 'archive'
              ? t(
                  'components.settings.workspaceCleanup.rules.archiveDescription',
                  'Archive frees disk space and keeps the workspace in the sidebar.'
                )
              : t(
                  'components.settings.workspaceCleanup.rules.deleteDescription',
                  'Delete removes the workspace and its folder.'
                )
          }
          control={
            <SettingsSegmentedControl<WorkspaceCleanupInactiveAction>
              size="sm"
              value={rules.inactive.action}
              onChange={(action) => setInactive({ action })}
              ariaLabel={t('components.settings.workspaceCleanup.rules.then', 'Then')}
              options={[
                {
                  value: 'archive',
                  disabled,
                  label: t('components.settings.workspaceCleanup.rules.archive', 'Archive')
                },
                {
                  value: 'delete',
                  disabled,
                  label: t('components.settings.workspaceCleanup.rules.delete', 'Delete')
                }
              ]}
            />
          }
        />
      ) : null}
    </div>
  )
}

function RuleMatchesLine({
  matches
}: {
  matches: WorkspaceCleanupRuleMatches
}): React.JSX.Element | null {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  if (matches.rows.length === 0) {
    return null
  }
  return (
    <>
      <span className="mt-1 block tabular-nums">
        {t(
          'components.settings.workspaceCleanup.rules.matchesCount',
          'Matches {{count}} workspaces now',
          { count: matches.rows.length, defaultValue_one: 'Matches 1 workspace now' }
        )}
        {matches.sizeBytes > 0 ? ` · ${formatBytes(matches.sizeBytes)}` : null}
        {' · '}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="underline decoration-muted-foreground/50 underline-offset-4 hover:text-foreground"
        >
          {open
            ? t('components.settings.workspaceCleanup.rules.hideMatches', 'Hide')
            : t('components.settings.workspaceCleanup.rules.showMatches', 'Show')}
        </button>
      </span>
      {open ? (
        <span className="mt-1 block space-y-0.5">
          {matches.rows.map((row) => (
            <WorkspaceCleanupWorkspaceLine
              key={`${row.executionHostId ?? ''}:${row.worktreeId}`}
              workspace={row}
              trailing={row.sizeBytes !== undefined ? formatBytes(row.sizeBytes) : undefined}
            />
          ))}
        </span>
      ) : null}
    </>
  )
}
