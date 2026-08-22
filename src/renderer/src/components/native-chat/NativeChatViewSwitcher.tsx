import { translate } from '@/i18n/i18n'

export type NativeChatViewSwitcherProps = {
  isChatViewMode: boolean
  onToggleNativeChat?: () => void
}

/** Top-level Chat | Terminal switch for the active agent session. */
export function NativeChatViewSwitcher({
  isChatViewMode,
  onToggleNativeChat
}: NativeChatViewSwitcherProps): React.JSX.Element {
  const terminalLabel = translate('components.native-chat.toggle.terminal', 'Terminal')
  const chatLabel = translate('components.native-chat.toggle.chat', 'Chat')
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return
    }
    event.preventDefault()
    onToggleNativeChat?.()
  }

  return (
    <div
      role="tablist"
      aria-orientation="horizontal"
      aria-label={translate('components.native-chat.toggle.viewSwitcher', 'Session view')}
      className="titlebar-session-view-switcher"
    >
      <button
        type="button"
        role="tab"
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
        type="button"
        role="tab"
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
  )
}
