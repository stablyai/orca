import { useEffect, useRef } from 'react'
import { Download, ShieldQuestion, TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NativeChatStartupNotice } from '../../../../shared/native-chat-startup-notice'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-types'

// i18n keys under components.native-chat.startupNotice.title.*, camelCased from the reason/
// phase; `notice.title` (the shared module's canonical English) is the translate() fallback,
// same dual-use as NATIVE_CHAT_EMPTY_STATE_COPY in native-chat-empty-state.ts.
const REASON_TITLE_KEYS: Record<RuntimeTerminalWaitBlockedReason, string> = {
  'codex-update-prompt': 'codexUpdatePrompt',
  'codex-trust-workspace': 'codexTrustWorkspace',
  'codex-cwd-prompt': 'codexCwdPrompt',
  'codex-model-migration-prompt': 'codexModelMigrationPrompt',
  'codex-hooks-review-prompt': 'codexHooksReviewPrompt',
  'codex-interactive-prompt': 'codexInteractivePrompt',
  'agent-approval-prompt': 'agentApprovalPrompt'
}
const PHASE_TITLE_KEYS: Record<Exclude<NativeChatStartupNotice['phase'], 'prompt'>, string> = {
  running: 'running',
  'restart-required': 'restartRequired',
  'update-failed': 'updateFailed',
  restarting: 'restarting'
}

function titleForNotice(notice: NativeChatStartupNotice): string {
  const key =
    notice.phase === 'prompt' && notice.reason
      ? REASON_TITLE_KEYS[notice.reason]
      : PHASE_TITLE_KEYS[notice.phase as Exclude<NativeChatStartupNotice['phase'], 'prompt'>]
  return translate(`components.native-chat.startupNotice.title.${key}`, notice.title)
}

export type NativeChatStartupNoticeCardProps = {
  notice: NativeChatStartupNotice
  /** Send a parsed option's literal string to the agent's PTY (a menu digit, `\r`, `t`). */
  onChoose: (send: string) => void
  /** Present only on `restart-required` / `update-failed` — the update finished (or died)
   *  and Codex needs a manual restart. Omitted while a restart is already underway. */
  onRestart?: () => void
  /** Always available: drop back to the raw terminal without leaving the dialog unresolved. */
  onOpenTerminal?: () => void
}

function iconForNotice(notice: NativeChatStartupNotice): typeof Download {
  if (notice.phase === 'update-failed') {
    return TriangleAlert
  }
  if (
    notice.phase === 'running' ||
    notice.phase === 'restart-required' ||
    notice.phase === 'restarting'
  ) {
    return Download
  }
  if (notice.reason === 'codex-trust-workspace') {
    return ShieldQuestion
  }
  if (notice.reason === 'codex-update-prompt' || notice.reason === 'codex-model-migration-prompt') {
    return Download
  }
  return TriangleAlert
}

/**
 * Renders a Codex startup takeover the chat view otherwise has no way to show — a blocking
 * dialog (update prompt, trust, hooks-review, …) or the self-update's own running/
 * restart-required/update-failed/restarting phases. Modeled on NativeChatApprovalCard: same
 * container and "first option is primary" button styling, so the two read as one family.
 */
export function NativeChatStartupNoticeCard({
  notice,
  onChoose,
  onRestart,
  onOpenTerminal
}: NativeChatStartupNoticeCardProps): React.JSX.Element {
  const Icon = iconForNotice(notice)
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = logRef.current
    if (el) {
      el.scrollTop = el.scrollHeight
    }
  }, [notice.body])

  const primaryActions = [
    ...notice.options.map((option) => ({
      label: option.label,
      onClick: () => onChoose(option.send)
    })),
    ...(onRestart
      ? [
          {
            label: translate('components.native-chat.startupNotice.restart', 'Restart Codex'),
            onClick: onRestart
          }
        ]
      : [])
  ]

  return (
    <div className="shrink-0 bg-background">
      <div className="mx-auto w-full max-w-4xl px-3 pt-2 pb-1 sm:px-4">
        <div className="flex w-full flex-col gap-2 rounded-lg border border-input bg-card px-4 py-3 shadow-xs">
          <div className="flex items-start gap-2">
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-sm font-semibold text-foreground">{titleForNotice(notice)}</p>
          </div>
          {notice.body.length > 0 ? (
            <div
              ref={logRef}
              aria-live="polite"
              className="scrollbar-sleek max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/50 px-2 py-1.5 font-mono text-xs text-muted-foreground"
            >
              {notice.body.join('\n')}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {primaryActions.map((action, i) => (
              <button
                key={`${action.label}-${i}`}
                type="button"
                onClick={action.onClick}
                className={cn(
                  'rounded-md px-4 py-1.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  i === 0
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'border border-border bg-background text-foreground hover:bg-accent'
                )}
              >
                {action.label}
              </button>
            ))}
            {onOpenTerminal ? (
              <button
                type="button"
                onClick={onOpenTerminal}
                className="rounded-md border border-border bg-background px-4 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {translate('components.native-chat.startupNotice.openTerminal', 'Open terminal')}
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
