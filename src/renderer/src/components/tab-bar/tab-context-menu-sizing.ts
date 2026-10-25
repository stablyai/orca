// Size menus to localized labels and platform shortcut widths, capped to the viewport.
export const TAB_CONTEXT_MENU_CONTENT_CLASS =
  'min-w-[13rem] max-w-[calc(100vw-1rem)] whitespace-nowrap'

/** Submenus portal out of the parent menu, so they can't inherit its nowrap. */
export const TAB_CONTEXT_SUBMENU_CONTENT_CLASS = 'max-w-[calc(100vw-1rem)] whitespace-nowrap'
