// Home's tab mark (UX design A): a theme-accent underline, shown whether or not Home is the active tab.

/** Drawn inside Home's tab root over the active indicator; the tab's background still says whether it is active. */
export function BotHomeTabAccent(): React.JSX.Element {
  return (
    <span
      aria-hidden
      data-bot-home-accent=""
      className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-[2px] bg-theme-accent"
    />
  )
}

/** Home's title reads heavier than its side chats', so it stands out at a glance. */
export const BOT_HOME_TAB_LABEL_CLASSES = 'font-semibold'
