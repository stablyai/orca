import { createPortal } from 'react-dom'
import { translate } from '@/i18n/i18n'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import {
  useConversationSwitchNote,
  type ConversationSwitchSurface
} from '@/lib/conversation-switch-state'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import { makePaneKey } from '../../../../shared/stable-pane-id'

/**
 * What a switch is doing while its source still shows (Brennan 11-01: "users may not be switched
 * for a few seconds and they'll be confused"). The destination replacing the source ends it; a
 * refusal or failure ends it too, leaving that failure's own message as the only one.
 */
export function ConversationSwitchNote({
  surface
}: {
  surface: ConversationSwitchSurface
}): React.JSX.Element | null {
  const note = useConversationSwitchNote(surface)
  if (!note) {
    return null
  }
  return (
    <div
      role="status"
      data-conversation-switch-note={note.direction}
      className="pointer-events-none absolute inset-x-3 bottom-3 z-50 flex items-start gap-2.5 rounded-md border border-border bg-popover px-3.5 py-2.5 text-xs text-popover-foreground"
    >
      <LoadingSpinner className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium">
          {note.direction === 'chat'
            ? translate('components.tab.bar.switch.switchingToNativeChat', 'Switching to Chat UI…')
            : translate('components.tab.bar.switch.switchingToCli', 'Switching to CLI…')}
        </div>
        <div className="text-muted-foreground">
          {translate(
            'components.tab.bar.switch.switchingDetail',
            "Stopping {{agent}}. The conversation continues here when it's ready.",
            { agent: agentLabel(note.agent) }
          )}
        </div>
      </div>
    </div>
  )
}

/** The note on each terminal pane being switched, whichever pane is active. A pane showing its
 *  stopped state already says what happened, so it shows one notice at a time. */
export function ConversationSwitchNotePortals({
  tabId,
  panes,
  stoppedPaneIds
}: {
  tabId: string
  panes: readonly { id: number; leafId: string; container: HTMLElement }[]
  stoppedPaneIds: Readonly<Record<number, unknown>>
}): React.JSX.Element {
  return (
    <>
      {panes.map((pane) =>
        stoppedPaneIds[pane.id]
          ? null
          : createPortal(
              <ConversationSwitchNote surface={{ paneKey: makePaneKey(tabId, pane.leafId) }} />,
              pane.container,
              `switch-note-${pane.id}`
            )
      )}
    </>
  )
}
