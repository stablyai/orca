import { TerminalSquare, TriangleAlert } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-types'

/**
 * Names the class of dialog blocking the pane. The `codex-` prefixes are
 * historical — the runtime matches these by shape and they fire for other
 * agents too — so the copy stays vendor-neutral.
 */
const WAIT_BLOCKED_DIALOG_LABEL: Record<RuntimeTerminalWaitBlockedReason, string> = {
  'codex-update-prompt': 'an update prompt',
  'codex-trust-workspace': 'a workspace trust prompt',
  'codex-cwd-prompt': 'a working-directory prompt',
  'codex-model-migration-prompt': 'a model migration prompt',
  'codex-hooks-review-prompt': 'a hooks review prompt',
  'codex-interactive-prompt': 'an interactive prompt',
  'agent-approval-prompt': 'an approval prompt'
}

/**
 * Surfaced when the pane hosting this chat is blocked on a startup dialog the
 * transcript cannot show (#15597): the chat reads only the agent transcript,
 * which has nothing before the first turn, so without this banner the user
 * stares at an empty chat while the real interactive UI waits one toggle away.
 */
export function NativeChatWaitBlockedBanner({
  reason,
  onSwitchToTerminal
}: {
  reason: RuntimeTerminalWaitBlockedReason
  onSwitchToTerminal?: () => void
}): React.JSX.Element {
  return (
    <div
      data-wait-blocked-reason={reason}
      className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      <TriangleAlert className="size-4 shrink-0 text-destructive" />
      <p className="min-w-0 flex-1 text-balance">
        {translate(
          'components.native-chat.waitBlocked.message',
          'This terminal is waiting on {{value0}} before the agent can start. Answer it in the terminal view.',
          { value0: WAIT_BLOCKED_DIALOG_LABEL[reason] }
        )}
      </p>
      {onSwitchToTerminal ? (
        <Button type="button" variant="outline" size="sm" onClick={onSwitchToTerminal}>
          <TerminalSquare className="size-3.5" />
          {translate('components.native-chat.waitBlocked.switchToTerminal', 'Terminal view')}
        </Button>
      ) : null}
    </div>
  )
}
