import { useCallback, useEffect, useState } from 'react'
import { SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import type {
  LocalCommandAuditEntry,
  LocalCommandAuditOutcome,
  LocalCommandsState,
  LocalCommandWorkspaceRow
} from '../../../../../shared/local-commands/local-command-desktop-types'
import { CloudApiEmptyState } from '../cloud-api/cloud-api-parts'
import { SettingsBadge, SettingsRow } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { LocalCommandText } from '../../local-commands/LocalCommandText'

const AUDIT_ROWS = 20

function workspaceDetail(row: LocalCommandWorkspaceRow, t: Translate): string {
  if (row.isOwner === false) {
    return t('localCommands.settings.notOwner', 'Only the workspace owner can turn this on.')
  }
  if (!row.enabled) {
    return row.shared
      ? t('localCommands.settings.offShared', 'Off · Shared with your team')
      : t('localCommands.settings.off', 'Off')
  }
  const sharing = row.shared
    ? ` · ${t('localCommands.settings.sharedOn', 'Shared with your team')}`
    : ''
  return row.connected
    ? `${t('localCommands.settings.onConnected', 'On · Connected')}${sharing}`
    : `${t('localCommands.settings.onWaiting', 'On · Connects when the workspace is running')}${sharing}`
}

function outcomeLabel(outcome: LocalCommandAuditOutcome, t: Translate): string {
  switch (outcome) {
    case 'allowed-once':
      return t('localCommands.audit.allowedOnce', 'Allowed once')
    case 'always-allowed':
      return t('localCommands.audit.alwaysAllowed', 'Always allowed')
    case 'auto-allowed':
      return t('localCommands.audit.autoAllowed', 'Allowed by rule')
    case 'denied':
      return t('localCommands.audit.denied', 'Denied')
    case 'timed-out':
      return t('localCommands.audit.timedOut', 'Not answered')
    case 'refused':
      return t('localCommands.audit.refused', 'Refused')
    case 'closed':
      return t('localCommands.audit.closed', 'Closed')
  }
}

function resultLabel(entry: LocalCommandAuditEntry, t: Translate): string | null {
  if (entry.timedOut) {
    return t('localCommands.audit.resultTimedOut', 'Timed out')
  }
  if (entry.signal) {
    return t('localCommands.audit.resultSignal', 'Stopped ({{signal}})', { signal: entry.signal })
  }
  if (entry.exitCode === 0) {
    return t('localCommands.audit.resultFinished', 'Finished')
  }
  if (typeof entry.exitCode === 'number') {
    return t('localCommands.audit.resultFailed', 'Failed (exit {{code}})', { code: entry.exitCode })
  }
  return null
}

export type LocalCommandsPaneProps = {
  state: LocalCommandsState | null | 'failed'
  audit: LocalCommandAuditEntry[]
  pendingSandboxId: string | null
  now: number
  onToggle: (row: LocalCommandWorkspaceRow) => void
  onRemoveRule: (id: string) => void
  onRetry: () => void
}

export function OrcaCloudLocalCommandsView({
  state,
  audit,
  pendingSandboxId,
  now,
  onToggle,
  onRemoveRule,
  onRetry
}: LocalCommandsPaneProps): React.JSX.Element {
  const t = useTranslate()
  if (state === 'failed') {
    return (
      <InlineError
        title={t('localCommands.settings.loadFailed', 'Couldn’t load local command settings')}
        retryLabel={t('cloudEnvironment.retry', 'Try again')}
        onRetry={onRetry}
      />
    )
  }
  if (state === null) {
    return (
      <div className="space-y-3" aria-busy>
        <span className="sr-only">{t('localCommands.settings.loading', 'Loading…')}</span>
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }
  if (!state.available) {
    return (
      <InlineError
        tone="neutral"
        title={t(
          'localCommands.settings.unavailable',
          'Local commands are available on macOS and Linux.'
        )}
      />
    )
  }
  return (
    <div className="space-y-8">
      {state.workspaces.length === 0 ? (
        <SettingsGroup>
          <CloudApiEmptyState
            icon={SquareTerminal}
            title={t('localCommands.settings.emptyTitle', 'No cloud workspaces on this computer')}
            description={t(
              'localCommands.settings.emptyBody',
              'Cloud workspaces you create from this computer appear here. Local commands stay off until you turn them on for a workspace.'
            )}
          />
        </SettingsGroup>
      ) : (
        <SettingsGroup
          title={t('localCommands.settings.workspacesTitle', 'Workspaces')}
          description={t(
            'localCommands.settings.workspacesBody',
            'Off by default. When on, you approve each command, and commands run only while Orca is open on this computer.'
          )}
        >
          {state.workspaces.map((row) => (
            <SettingsRow
              key={row.sandboxId}
              label={row.label}
              description={workspaceDetail(row, t)}
              control={
                <Switch
                  checked={row.enabled}
                  disabled={row.isOwner === false || pendingSandboxId === row.sandboxId}
                  aria-label={t(
                    'localCommands.settings.toggleLabel',
                    'Allow local commands from {{workspace}}',
                    { workspace: row.label }
                  )}
                  onCheckedChange={() => onToggle(row)}
                />
              }
            />
          ))}
        </SettingsGroup>
      )}

      <SettingsGroup
        title={t('localCommands.settings.rulesTitle', 'Always allowed')}
        description={t(
          'localCommands.settings.rulesBody',
          'These exact commands run without asking, only in the same workspace and folder. Turning a workspace off removes its rules.'
        )}
      >
        {state.rules.length === 0 ? (
          <p className="py-3 text-xs text-muted-foreground">
            {t('localCommands.settings.rulesEmpty', 'No commands are always allowed.')}
          </p>
        ) : (
          state.rules.map((rule) => (
            <SettingsRow
              key={rule.id}
              label={
                <span className="block truncate font-mono text-xs" title={rule.command}>
                  <LocalCommandText text={rule.command} />
                </span>
              }
              description={`${rule.workspaceLabel} · ${rule.cwd}`}
              control={
                <Button variant="ghost" size="sm" onClick={() => onRemoveRule(rule.id)}>
                  {t('localCommands.settings.removeRule', 'Remove')}
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>

      <SettingsGroup
        title={t('localCommands.settings.auditTitle', 'Recent requests')}
        description={t(
          'localCommands.settings.auditBody',
          'Every request and what happened to it. Output is never kept.'
        )}
      >
        {audit.length === 0 ? (
          <p className="py-3 text-xs text-muted-foreground">
            {t('localCommands.settings.auditEmpty', 'No requests yet.')}
          </p>
        ) : (
          audit.slice(0, AUDIT_ROWS).map((entry) => {
            const result = resultLabel(entry, t)
            return (
              <div
                key={`${entry.requestId}-${entry.at}`}
                data-settings-row=""
                className="flex items-start justify-between gap-4 py-2.5"
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="truncate font-mono text-xs" title={entry.command}>
                    {entry.command ? (
                      <LocalCommandText text={entry.command} />
                    ) : (
                      t('localCommands.audit.noCommand', '(unreadable request)')
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[
                      entry.workspaceLabel,
                      formatUiRelativeTime(entry.at - now),
                      result,
                      entry.detail
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
                <SettingsBadge
                  tone={
                    entry.outcome === 'denied' || entry.outcome === 'refused' ? 'muted' : 'neutral'
                  }
                >
                  {outcomeLabel(entry.outcome, t)}
                </SettingsBadge>
              </div>
            )
          })
        )}
      </SettingsGroup>

      <p className="text-xs text-muted-foreground">
        {t(
          'localCommands.settings.footnote',
          'Commands run with /bin/sh in your home folder or the folder the agent names, with only PATH, HOME and locale set. They get no input, stop at their timeout, and output is cut at 128 KB. A request waits up to 5 minutes for you.'
        )}
      </p>
    </div>
  )
}

export function OrcaCloudLocalCommandsPane(): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const [state, setState] = useState<LocalCommandsState | null | 'failed'>(null)
  const [audit, setAudit] = useState<LocalCommandAuditEntry[]>([])
  const [loadedAt, setLoadedAt] = useState(0)
  const [pendingSandboxId, setPendingSandboxId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  const load = useCallback(async () => {
    const api = window.api.localCommands
    if (!api) {
      setState({ available: false, workspaces: [], rules: [] })
      return
    }
    try {
      const [next, entries] = await Promise.all([api.getState(), api.listAudit(AUDIT_ROWS)])
      setState(next)
      setAudit(entries)
      setLoadedAt(Date.now())
    } catch {
      setState('failed')
    }
  }, [])

  useEffect(() => {
    void load()
    const stopState = window.api.localCommands?.onStateChanged(() => void load())
    // A prompt answered elsewhere lands in the audit log; refresh the list with it.
    const stopPrompts = window.api.localCommands?.onPrompts(() => void load())
    return () => {
      stopState?.()
      stopPrompts?.()
    }
  }, [load, attempt])

  const toggle = useCallback(
    async (row: LocalCommandWorkspaceRow) => {
      const api = window.api.localCommands
      if (!api) {
        return
      }
      const enabling = !row.enabled
      let allowShared = false
      const confirmShared = (): Promise<boolean> =>
        confirm({
          title: t(
            'localCommands.settings.sharedConfirmTitle',
            'Allow commands from a shared workspace?'
          ),
          description: t(
            'localCommands.settings.sharedConfirmBody',
            'Teammates can message the agent in {{workspace}}, so their messages can also lead to requests to run commands on this computer. You still approve each one, and commands you always allowed before are cleared.',
            { workspace: row.label }
          ),
          confirmLabel: t('localCommands.settings.sharedConfirmAction', 'Turn on'),
          surface: 'security',
          initialFocus: 'cancel'
        })
      if (enabling && row.shared && !(allowShared = await confirmShared())) {
        return
      }
      setPendingSandboxId(row.sandboxId)
      setError(null)
      try {
        let result = await api.setEnabled({
          sandboxId: row.sandboxId,
          enabled: enabling,
          allowShared
        })
        // Sharing wasn't known when the row rendered: ask now, then try once more.
        if (!result.ok && result.error === 'shared_needs_confirmation' && (await confirmShared())) {
          result = await api.setEnabled({
            sandboxId: row.sandboxId,
            enabled: true,
            allowShared: true
          })
        }
        if (!result.ok && result.error !== 'shared_needs_confirmation') {
          setError(
            result.error === 'not_owner'
              ? t(
                  'localCommands.settings.errorNotOwner',
                  'Only the workspace owner can turn this on.'
                )
              : t(
                  'localCommands.settings.errorUnverified',
                  'Couldn’t confirm who owns this workspace. Check your connection and try again.'
                )
          )
        }
      } finally {
        setPendingSandboxId(null)
        await load()
      }
    },
    [confirm, load, t]
  )

  return (
    <div className="space-y-3">
      {error ? <InlineError title={error} /> : null}
      <OrcaCloudLocalCommandsView
        state={state}
        audit={audit}
        pendingSandboxId={pendingSandboxId}
        now={loadedAt}
        onToggle={(row) => void toggle(row)}
        onRemoveRule={(id) => void window.api.localCommands?.removeRule(id).then(() => load())}
        onRetry={() => {
          setState(null)
          setAttempt((value) => value + 1)
        }}
      />
    </div>
  )
}
