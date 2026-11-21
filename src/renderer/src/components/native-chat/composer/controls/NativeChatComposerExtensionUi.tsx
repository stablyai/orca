import { NativeChatComposerTabStrip } from './NativeChatComposerTabStrip'
import type {
  AgentSessionExtensionStripRows,
  AgentSessionExtensionWidgetRow
} from '../../../../../../shared/agent-session/view/agent-session-extension-ui'

/** Pi extensions draw keyed text beside the composer; the chat shows it as sent, above or below the input. */
export function NativeChatComposerExtensionUi({
  rows,
  placement
}: {
  rows: AgentSessionExtensionStripRows
  placement: 'above' | 'below'
}): React.JSX.Element | null {
  const widgets = rows.widgets.filter((widget) => widget.placement === placement)
  // Statuses are the extension's own status bar: one line above the input, like a footer.
  const statuses = placement === 'above' ? rows.statuses : []
  if (widgets.length === 0 && statuses.length === 0) {
    return null
  }
  return (
    <>
      {widgets.length === 0 ? null : (
        // One capped stack per placement, so a child's panels can never push the composer out of the pane.
        <div
          className="scrollbar-sleek max-h-40 shrink-0 overflow-y-auto"
          data-native-chat-extension-widgets=""
        >
          {widgets.map((widget) => (
            <NativeChatExtensionWidget key={widget.itemId} widget={widget} />
          ))}
        </div>
      )}
      {statuses.length === 0 ? null : (
        <NativeChatComposerTabStrip data-native-chat-extension-status="">
          {statuses.map((status) => (
            <span key={status.itemId} className="min-w-0 truncate py-1">
              {status.text}
            </span>
          ))}
        </NativeChatComposerTabStrip>
      )}
    </>
  )
}

function NativeChatExtensionWidget({
  widget
}: {
  widget: AgentSessionExtensionWidgetRow
}): React.JSX.Element {
  return (
    <NativeChatComposerTabStrip layout="stack" data-native-chat-extension-widget="">
      <div className="px-3 py-1 font-mono text-chat-code whitespace-pre-wrap break-words text-muted-foreground">
        {widget.lines.join('\n')}
      </div>
    </NativeChatComposerTabStrip>
  )
}
