import { X, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../shared/tui-agent-display-names'
import type {
  AgentLaunchNotice,
  AgentLaunchNoticeCode,
  PersistedLaunchNoticeState
} from '../../../../shared/agent-launch-contract'
import { useAppStore } from '../../store'

const EMPTY_TABS: { id: string; launchNotices?: PersistedLaunchNoticeState }[] = []

/** Fallback/env notices stay in a persistent banner; snapshot_definition_changed
 *  is informational and renders as a quiet inline chip — never the banner tier. */
const CHIP_TIER_CODES: ReadonlySet<AgentLaunchNoticeCode> = new Set(['snapshot_definition_changed'])

function isChipTier(notice: AgentLaunchNotice): boolean {
  return CHIP_TIER_CODES.has(notice.code)
}

/** Honest per-code durable copy (plan §UX). `{{value0}}` is the requested agent
 *  label; `{{value1}}` is the stock base agent's product name. */
export function resolveLaunchNoticeText(notice: AgentLaunchNotice): string {
  switch (notice.code) {
    case 'disabled_custom_fallback':
      return translate(
        'auto.components.AgentLaunchNotices.disabledFallback',
        '{{value0}} is disabled. Started stock {{value1}} with no custom executable, custom arguments, or custom agent environment.',
        { value0: notice.label, value1: TUI_AGENT_DISPLAY_NAMES[notice.baseAgent] }
      )
    case 'missing_custom_fallback':
      return translate(
        'auto.components.AgentLaunchNotices.missingFallback',
        '{{value0}} was deleted. Started stock {{value1}} with no custom executable, custom arguments, or custom agent environment.',
        { value0: notice.label, value1: TUI_AGENT_DISPLAY_NAMES[notice.baseAgent] }
      )
    case 'env_withheld':
      return translate(
        'auto.components.AgentLaunchNotices.envWithheld',
        "This launch did not use all of {{value0}}'s environment values. Manage paired-launch env on the desktop host.",
        { value0: notice.label }
      )
    case 'snapshot_definition_changed':
      return translate(
        'auto.components.AgentLaunchNotices.snapshotChanged',
        'Resumed with the settings captured when this session started.'
      )
    case 'vault_original_config_unavailable':
      return translate(
        'auto.components.AgentLaunchNotices.vaultOriginalConfigUnavailable',
        "Original launch settings weren't available. Resumed with current {{value0}} settings.",
        { value0: TUI_AGENT_DISPLAY_NAMES[notice.baseAgent] }
      )
  }
}

function DismissButton({
  onDismiss,
  className
}: {
  onDismiss: () => void
  className?: string
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className={className}
      aria-label={translate('auto.components.AgentLaunchNotices.dismiss', 'Dismiss')}
      onClick={onDismiss}
    >
      <X className="size-3.5" aria-hidden="true" />
    </Button>
  )
}

/** Presentational notice list. Kept free of store/IPC so it renders per-code
 *  copy deterministically and reports dismissal through `onDismiss`. */
export function AgentLaunchNoticeList({
  notices,
  onDismiss
}: {
  notices: readonly AgentLaunchNotice[]
  onDismiss: (code: AgentLaunchNoticeCode) => void
}): React.JSX.Element | null {
  if (notices.length === 0) {
    return null
  }
  const bannerNotices = notices.filter((notice) => !isChipTier(notice))
  const chipNotices = notices.filter(isChipTier)
  return (
    <div className="flex shrink-0 flex-col border-b border-border bg-card text-card-foreground">
      {bannerNotices.map((notice) => (
        <div
          key={notice.code}
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 px-3 py-2"
        >
          <TriangleAlert
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1 text-sm leading-snug">
            {resolveLaunchNoticeText(notice)}
          </div>
          <DismissButton onDismiss={() => onDismiss(notice.code)} className="-my-0.5 shrink-0" />
        </div>
      ))}
      {chipNotices.map((notice) => (
        <div
          key={notice.code}
          role="status"
          aria-live="polite"
          className="flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground"
        >
          <span className="min-w-0 flex-1 truncate">{resolveLaunchNoticeText(notice)}</span>
          <DismissButton onDismiss={() => onDismiss(notice.code)} className="-my-0.5 shrink-0" />
        </div>
      ))}
    </div>
  )
}

/** Host-owned notice banner for the active terminal tab. Mounted in normal flow
 *  above the terminal so the existing ResizeObserver refits on mount/dismiss. */
export function AgentLaunchNotices({
  worktreeId,
  tabId
}: {
  worktreeId: string
  tabId: string | null
}): React.JSX.Element | null {
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId] ?? EMPTY_TABS)
  const dismissLaunchNotice = useAppStore((s) => s.dismissLaunchNotice)
  const tab = tabId ? tabs.find((candidate) => candidate.id === tabId) : undefined
  const launchNotices = tab?.launchNotices
  if (!tab || !launchNotices || launchNotices.notices.length === 0) {
    return null
  }
  return (
    <AgentLaunchNoticeList
      notices={launchNotices.notices}
      onDismiss={(code) =>
        dismissLaunchNotice({
          worktreeId,
          tabId: tab.id,
          launchToken: launchNotices.launchToken,
          code
        })
      }
    />
  )
}
