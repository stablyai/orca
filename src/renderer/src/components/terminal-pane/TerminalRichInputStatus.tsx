import { SquareTerminal } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { TerminalRichInputSubmitResult } from './terminal-rich-input-submit'

// Why not "error": an unconfirmed send most likely did land — the agent just never
// redrew within the wait — so it is a caution to check the terminal, not a failure.
export type TerminalRichInputSendNotice =
  | Exclude<TerminalRichInputSubmitResult['status'], 'submitted'>
  | 'unconfirmed'
  | null

export function terminalRichInputNewlineShortcut(
  platform: NodeJS.Platform = getShortcutPlatform()
): string {
  return platform === 'darwin' ? '⇧+Enter' : 'Shift+Enter'
}

/** Message for one status state. Pure so the wording is testable without a render. */
export function terminalRichInputStatusText(notice: TerminalRichInputSendNotice): string {
  if (notice === 'partially-written') {
    return translate(
      'components.terminal.richInput.sendPartial',
      'Part of the input was pasted. Check the terminal before retrying.'
    )
  }
  if (notice === 'unconfirmed') {
    return translate(
      'components.terminal.richInput.sendUnconfirmed',
      'Sent, but the agent did not confirm. Check the terminal.'
    )
  }
  if (notice) {
    return translate('components.terminal.richInput.sendFailed', 'Terminal input was not sent.')
  }
  return translate(
    'components.terminal.richInput.hint',
    'Enter to send \u00b7 {{value0}} for newline',
    { value0: terminalRichInputNewlineShortcut() }
  )
}

export function TerminalRichInputStatus({
  notice
}: {
  notice: TerminalRichInputSendNotice
}): React.JSX.Element {
  const toggleShortcut = useShortcutKeyDetails('terminal.richInput.toggle')
  const text = terminalRichInputStatusText(notice)
  return (
    <>
      <SquareTerminal className="size-3.5 text-muted-foreground" />
      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span>{text}</span>
        {!notice && toggleShortcut.keys.length > 0 ? (
          <>
            <span>·</span>
            <ShortcutKeyCombo
              keys={toggleShortcut.keys}
              doubleTap={toggleShortcut.doubleTap}
              className="gap-0.5"
              separatorClassName="mx-0 text-[10px] text-muted-foreground"
              keyCapClassName="min-w-4 rounded-sm px-1 py-0 text-[10px] font-normal shadow-none"
            />
            <span>{translate('components.terminal.richInput.shortcutHint', 'to close')}</span>
          </>
        ) : null}
      </div>
    </>
  )
}
