import { Bot } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { isMacPlatform, nativeChatToggleShortcutLabel } from './native-chat-shortcut'

export type NativeChatViewSwitcherProps = {
  isChatViewMode: boolean
  onToggleNativeChat?: () => void
  contextLabel: string
  contextDetail?: string | null
  instanceId: string
  chatPanelId: string
  terminalPanelId: string
}

/** Top-level Chat | Terminal switch for the active agent session. */
export function NativeChatViewSwitcher({
  isChatViewMode,
  onToggleNativeChat,
  contextLabel,
  contextDetail,
  instanceId,
  chatPanelId,
  terminalPanelId
}: NativeChatViewSwitcherProps): React.JSX.Element {
  const terminalLabel = translate('components.native-chat.toggle.terminal', 'Terminal')
  const chatLabel = translate('components.native-chat.toggle.chat', 'Chat')
  const viewSwitcherLabel = translate('components.native-chat.toggle.viewSwitcher', 'Session view')
  const chatTabId = `${instanceId}-chat-tab`
  const terminalTabId = `${instanceId}-terminal-tab`
  const shortcutLabel = nativeChatToggleShortcutLabel(isMacPlatform())
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }
    event.preventDefault()
    const tabs = Array.from(
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []
    )
    const currentIndex = tabs.indexOf(event.currentTarget)
    const direction = event.key === 'ArrowRight' ? 1 : -1
    const nextTab = tabs[(currentIndex + direction + tabs.length) % tabs.length]
    nextTab?.focus()
    if (nextTab?.getAttribute('aria-selected') !== 'true') {
      onToggleNativeChat?.()
    }
  }

  return (
    <div className="titlebar-session-command">
      <div
        className="titlebar-session-context"
        title={contextDetail ? `${contextLabel} — ${contextDetail}` : contextLabel}
      >
        <span className="titlebar-session-agent-icon" aria-hidden="true">
          <Bot size={12} strokeWidth={1.8} />
        </span>
        <span className="titlebar-session-context-label">{contextLabel}</span>
        {contextDetail ? (
          <>
            <span className="titlebar-session-context-separator" aria-hidden="true" />
            <span className="titlebar-session-context-detail">{contextDetail}</span>
          </>
        ) : null}
      </div>
      <div
        role="tablist"
        aria-orientation="horizontal"
        aria-label={viewSwitcherLabel}
        title={`${viewSwitcherLabel} (${shortcutLabel})`}
        className="titlebar-session-view-switcher"
      >
        <button
          id={chatTabId}
          type="button"
          role="tab"
          aria-controls={chatPanelId}
          aria-selected={isChatViewMode}
          tabIndex={isChatViewMode ? 0 : -1}
          data-state={isChatViewMode ? 'active' : 'inactive'}
          onKeyDown={handleKeyDown}
          onClick={(event) => {
            event.stopPropagation()
            if (!isChatViewMode) {
              onToggleNativeChat?.()
            }
          }}
        >
          {chatLabel}
        </button>
        <button
          id={terminalTabId}
          type="button"
          role="tab"
          aria-controls={terminalPanelId}
          aria-selected={!isChatViewMode}
          tabIndex={isChatViewMode ? -1 : 0}
          data-state={isChatViewMode ? 'inactive' : 'active'}
          onKeyDown={handleKeyDown}
          onClick={(event) => {
            event.stopPropagation()
            if (isChatViewMode) {
              onToggleNativeChat?.()
            }
          }}
        >
          {terminalLabel}
        </button>
      </div>
    </div>
  )
}
