import React, { useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useAppStore } from '../../store'
import { summarizeCodexRestartStatus } from './codex-restart-status-summary'
import { translate } from '@/i18n/i18n'

export function CodexRestartStatusPrompt(): React.JSX.Element | null {
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const ptyIdsByTabId = useAppStore((s) => s.ptyIdsByTabId)
  const codexRestartNoticeByPtyId = useAppStore((s) => s.codexRestartNoticeByPtyId)
  const queuePaneAccountRestarts = useAppStore((s) => s.queuePaneAccountRestarts)

  const staleCodexStatus = useMemo(
    () =>
      summarizeCodexRestartStatus({
        tabsByWorktree,
        ptyIdsByTabId,
        codexRestartNoticeByPtyId
      }),
    [codexRestartNoticeByPtyId, ptyIdsByTabId, tabsByWorktree]
  )

  if (staleCodexStatus.staleTabCount === 0) {
    return null
  }

  return (
    <div className="mx-1 mb-1 flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
      <div className="min-w-0 flex-1 text-2xs text-foreground">
        {/* Why: notices are per-PTY-session but restart is per-pane; show both counts so split panes don't look wrong. */}
        {translate(
          'auto.components.status.bar.StatusBar.staleCodexSessions',
          '{{count}} Codex sessions are still on the old account.',
          {
            count: staleCodexStatus.staleSessionCount,
            defaultValue_one: '{{count}} Codex session is still on the old account.'
          }
        )}
        {staleCodexStatus.staleWorktreeCount > 1 ? (
          <span className="mt-0.5 block text-muted-foreground">
            {translate(
              'auto.components.status.bar.StatusBar.59c6e7b4e0',
              'Visible sessions restart now. Others restart when their worktree becomes active.'
            )}
          </span>
        ) : null}
      </div>
      <DropdownMenuItem
        asChild
        onSelect={(event) => {
          event.preventDefault()
          queuePaneAccountRestarts(staleCodexStatus.stalePtyIds, 'codex')
        }}
      >
        <Button type="button" variant="outline" size="xs" className="shrink-0">
          {staleCodexStatus.staleSessionCount === 1
            ? translate('auto.components.status.bar.StatusBar.6cd6650b4c', 'Restart Session')
            : translate(
                'auto.components.status.bar.StatusBar.cd9d7b40ff',
                'Restart {{value0}} Sessions',
                { value0: staleCodexStatus.staleSessionCount }
              )}
        </Button>
      </DropdownMenuItem>
    </div>
  )
}

export function AccountRuntimeToggle<TGroup extends { key: string; label: string }>({
  groups,
  value,
  onChange,
  ariaLabel
}: {
  groups: TGroup[]
  value: string
  onChange: (group: TGroup) => void
  ariaLabel: string
}): React.JSX.Element | null {
  if (groups.length <= 1) {
    return null
  }

  return (
    <div className="px-2 pt-2">
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className="inline-flex w-full items-center rounded-md border border-border bg-background/50 p-0.5"
      >
        {groups.map((group) => {
          const active = group.key === value
          return (
            <button
              key={group.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(group)}
              className={`min-w-0 flex-1 rounded-sm px-2 py-1 text-center text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 ${
                active
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span className="block truncate">{group.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
