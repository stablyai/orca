import type { Terminal } from '@xterm/xterm'
import { translate } from '@/i18n/i18n'
import { useTerminalCopyFlash } from './terminal-copy-flash-store'

type TerminalCopyFeedbackPopupProps = {
  paneId: number
  /** Live terminal whose theme supplies the ANSI green, like herdr's palette.green. */
  terminal: Pick<Terminal, 'options'>
}

export function TerminalCopyFeedbackPopup({
  paneId,
  terminal
}: TerminalCopyFeedbackPopupProps): React.JSX.Element | null {
  const visible = useTerminalCopyFlash(paneId)
  if (!visible) {
    return null
  }
  const green = terminal.options.theme?.green ?? 'var(--color-status-success)'
  return (
    // Decorative: copy-on-select can fire often, so screen readers must not hear repeats.
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center"
    >
      <div
        className="flex items-center gap-2 rounded-sm border bg-card/95 px-3 py-1 font-mono text-xs font-bold text-card-foreground shadow-xs"
        style={{ borderColor: green }}
      >
        <span style={{ color: green }}>●</span>
        {translate(
          'auto.components.terminal.pane.TerminalCopyFeedbackPopup.ab2ac75664',
          'copied to clipboard'
        )}
      </div>
    </div>
  )
}
