import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { formatBytes } from '../../../../../shared/text/format-bytes'
import {
  WORKSPACE_ARCHIVE_SUPPORTED,
  WORKSPACE_CLEANUP_POLICY_MAX_DAYS,
  WORKSPACE_CLEANUP_POLICY_MIN_DAYS,
  type WorkspaceCleanupInactiveAction,
  type WorkspaceCleanupRules
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-policy'
import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { Switch } from '../../ui/switch'
import {
  NumberField,
  SettingsBadge,
  SettingsRow,
  SettingsSegmentedControl
} from '../form-controls/SettingsFormControls'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroupDisclosure } from '../section-layout/SettingsGroupDisclosure'
import { matchesSettingsSearch } from '../search/settings-search'
import { getWorkspaceCleanupSettingsSearchParts } from './workspace-cleanup-settings-search'
import {
  WorkspaceCleanupWorkspaceLine,
  workspaceCleanupRowKey
} from './workspace-cleanup-workspace-line'
import type { WorkspaceCleanupRuleKey } from './workspace-cleanup-rule-keys'

export type WorkspaceCleanupRuleMatches = {
  rows: WorkspaceCleanupPreviewRow[]
  sizeBytes: number
}

/**
 * `checking`: turning a rule on, while its preview runs. `enabling`: that preview found nothing new
 * and the save is in flight. `saving`: any other change waiting on its write.
 */
export type WorkspaceCleanupRulePhase = 'checking' | 'enabling' | 'saving'

/** The Workspace Cleanup page's change in flight; a project's custom rules leave it unset. */
export type WorkspaceCleanupRuleOperation = {
  pending: { key: WorkspaceCleanupRuleKey; phase: WorkspaceCleanupRulePhase } | null
  /** A rule whose turn-on check failed and can be tried again. */
  failedKey: WorkspaceCleanupRuleKey | null
  /** The rule whose switch gets focus back when the confirm dialog closes. */
  returnTargetKey: WorkspaceCleanupRuleKey | null
  /** Switches stay focusable while busy; the toggle is dropped instead of natively disabled. */
  busy: boolean
  onRetry: () => void
  switchRef: (key: WorkspaceCleanupRuleKey, element: HTMLButtonElement | null) => void
}

type RuleRowsProps = {
  rules: WorkspaceCleanupRules
  onToggle: (key: WorkspaceCleanupRuleKey) => void
  /** Gets a change as a function so it applies to the rules as they are when it is saved. */
  onChange: (change: (rules: WorkspaceCleanupRules) => WorkspaceCleanupRules) => void
  /** What each rule that is on would remove now; omitted where no preview is read. */
  matches?: Partial<Record<WorkspaceCleanupRuleKey, WorkspaceCleanupRuleMatches>>
  operation?: WorkspaceCleanupRuleOperation
  /** Changes after a change that was not saved, so the Inactive fields show the saved values. */
  inactiveDraftKey?: number
  /** Natively disables every control while a change is in flight. */
  disabled?: boolean
  forceVisible?: boolean
}

const ADVANCED_RULES: ReadonlySet<WorkspaceCleanupRuleKey> = new Set([
  'automationRuns',
  'orchestrationWorkers'
])

function isAdvancedRule(key: WorkspaceCleanupRuleKey | null): boolean {
  return key !== null && ADVANCED_RULES.has(key)
}

/** The rule switches, shared by the Workspace Cleanup page and a project's custom rules. */
export function WorkspaceCleanupRuleRows({
  rules,
  onToggle,
  onChange,
  matches,
  operation,
  inactiveDraftKey,
  disabled = false,
  forceVisible = false
}: RuleRowsProps): React.JSX.Element {
  const t = useTranslate()
  const idPrefix = useId()
  const query = useAppStateValue((state) => state.settingsSearchQuery)
  const search = getWorkspaceCleanupSettingsSearchParts()
  const advancedMatches =
    query.trim() !== '' &&
    matchesSettingsSearch(query, [search.automationRuns, search.orchestrationWorkers])

  // Advanced opens for a rule being changed and stays open once the change settles, so the switch
  // that gets focus back is visible; only the user closes it again.
  const target = operation
    ? (operation.pending?.key ?? operation.failedKey ?? operation.returnTargetKey)
    : null
  const [advancedOpen, setAdvancedOpen] = useState(() => isAdvancedRule(target))
  const [revealedFor, setRevealedFor] = useState(target)
  if (target !== revealedFor) {
    setRevealedFor(target)
    if (isAdvancedRule(target)) {
      setAdvancedOpen(true)
    }
  }

  const ruleRow = (key: WorkspaceCleanupRuleKey, description: string, badge?: string) => {
    const phase = operation?.pending?.key === key ? operation.pending.phase : null
    const failed = operation?.failedKey === key && !rules[key].enabled
    const errorId = `${idPrefix}-${key}-check-failed`
    const shownOn = phase === 'checking' || phase === 'enabling' ? true : rules[key].enabled
    const blocked = Boolean(operation?.busy) && phase === null
    return (
      <SearchableSetting {...search[key]} forceVisible={forceVisible}>
        <SettingsRow
          label={
            // Inline, so a wrapping title carries its badge with it.
            <span className="leading-snug">
              {search[key].title}
              {badge ? <SettingsBadge className="ml-2 align-middle">{badge}</SettingsBadge> : null}
            </span>
          }
          description={
            <>
              {description}
              {phase === 'checking' ? (
                <span role="status" className="mt-1 flex items-center gap-1.5 text-foreground">
                  <Loader2 className="size-3 shrink-0 animate-spin motion-reduce:animate-none" />
                  {t(
                    'components.settings.workspaceCleanup.rules.checking',
                    'Checking which workspaces match…'
                  )}
                </span>
              ) : failed ? (
                <span id={errorId} role="alert" className="mt-1 block text-destructive">
                  {t(
                    'components.settings.workspaceCleanup.rules.checkFailed',
                    "Couldn't check which workspaces match."
                  )}{' '}
                  <button
                    type="button"
                    onClick={operation?.onRetry}
                    className="font-medium underline decoration-destructive/50 underline-offset-4 hover:decoration-destructive"
                  >
                    {t('components.settings.workspaceCleanup.retry', 'Try again')}
                  </button>
                </span>
              ) : matches?.[key] && rules[key].enabled ? (
                <RuleMatchesLine matches={matches[key]} />
              ) : null}
            </>
          }
          control={
            <Switch
              ref={operation ? (element) => operation.switchRef(key, element) : undefined}
              // Shown On while its turn-on is checked or saved; screen readers hear the saved value.
              checked={shownOn}
              aria-checked={rules[key].enabled}
              aria-disabled={blocked ? true : undefined}
              aria-describedby={failed ? errorId : undefined}
              disabled={disabled}
              pending={
                phase === null
                  ? undefined
                  : shownOn && !rules[key].enabled
                    ? 'turning-on'
                    : 'saving'
              }
              onCheckedChange={() => {
                if (!operation?.busy) {
                  onToggle(key)
                }
              }}
              aria-label={search[key].title}
            />
          }
        />
        {key === 'inactive' && rules.inactive.enabled ? (
          <InactiveRuleOptions
            key={inactiveDraftKey}
            rules={rules}
            onChange={onChange}
            disabled={disabled || Boolean(operation?.busy)}
          />
        ) : null}
      </SearchableSetting>
    )
  }

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
        // The page lines Advanced rows up with the others and keeps them open for a change.
        open={operation ? advancedOpen : undefined}
        onOpenChange={operation ? setAdvancedOpen : undefined}
        flush={operation !== undefined}
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
              key={workspaceCleanupRowKey(row)}
              workspace={row}
              trailing={row.sizeBytes !== undefined ? formatBytes(row.sizeBytes) : undefined}
            />
          ))}
        </span>
      ) : null}
    </>
  )
}
