// Why: a fixed menu width wraps labels onto a second line once the label or its
// shortcut chip grows — worst on Windows/Linux, where `Ctrl+Alt+W` is far wider
// than `⌘⌥W`, and in locales with longer copy. Size to content instead, capped
// so a long label still can't run off screen.
export const TAB_CONTEXT_MENU_CONTENT_CLASS =
  'min-w-[13rem] max-w-[calc(100vw-1rem)] whitespace-nowrap'

/** Submenus portal out of the parent menu, so they can't inherit its nowrap. */
export const TAB_CONTEXT_SUBMENU_CONTENT_CLASS = 'max-w-[calc(100vw-1rem)] whitespace-nowrap'
