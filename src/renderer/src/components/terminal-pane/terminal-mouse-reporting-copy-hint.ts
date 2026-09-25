import type { Terminal } from '@xterm/xterm'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { TERMINAL_SELECTION_OVER_MOUSE_REPORTING_SETTING_ID } from './terminal-selection-over-mouse-reporting-setting-anchor'

// Why a cooldown, not a session latch: the user who reaches for Cmd+C twice in
// a row should not see two toasts, but one who finds the hint later should.
export const MOUSE_REPORTING_COPY_HINT_COOLDOWN_MS = 10_000

type HintTerminal = { modes: Pick<Terminal['modes'], 'mouseTrackingMode'> }

export type MouseReportingCopyHintDeps = {
  now: () => number
  showToast: (args: {
    title: string
    description: string
    actionLabel: string
    onAction: () => void
  }) => void
  openSetting: () => void
}

let lastShownAt = Number.NEGATIVE_INFINITY

function openSelectionOverMouseReportingSetting(): void {
  const store = useAppStore.getState()
  store.setSettingsSearchQuery('')
  store.openSettingsTarget({
    pane: 'terminal',
    repoId: null,
    sectionId: TERMINAL_SELECTION_OVER_MOUSE_REPORTING_SETTING_ID
  })
  store.openSettingsPage()
}

function showHintToast(args: {
  title: string
  description: string
  actionLabel: string
  onAction: () => void
}): void {
  toast.info(args.title, {
    description: args.description,
    duration: 12_000,
    action: { label: args.actionLabel, onClick: args.onAction }
  })
}

const defaultDeps: MouseReportingCopyHintDeps = {
  now: () => Date.now(),
  showToast: showHintToast,
  openSetting: openSelectionOverMouseReportingSetting
}

/**
 * The copy shortcut found no xterm selection. When the app in the pane reports
 * the mouse, that is the expected outcome of a plain drag — the app, not xterm,
 * owns the selection — so say so instead of failing silently (#9727).
 * Returns whether a hint was shown.
 */
export function maybeShowMouseReportingCopyHint(
  terminal: HintTerminal,
  isMac: boolean,
  deps: MouseReportingCopyHintDeps = defaultDeps
): boolean {
  if (terminal.modes.mouseTrackingMode === 'none') {
    return false
  }
  const now = deps.now()
  if (now - lastShownAt < MOUSE_REPORTING_COPY_HINT_COOLDOWN_MS) {
    return false
  }
  lastShownAt = now
  deps.showToast({
    title: translate(
      'components.terminalPane.MouseReportingCopyHint.title',
      'Nothing selected to copy'
    ),
    description: isMac
      ? translate(
          'components.terminalPane.MouseReportingCopyHint.description',
          'This app is capturing the mouse, so dragging did not select text in the terminal. Hold Option while dragging, or turn on “Select Text in Mouse-Aware Apps”.'
        )
      : translate(
          'components.terminalPane.MouseReportingCopyHint.descriptionNonMac',
          'This app is capturing the mouse, so dragging did not select text in the terminal. Hold Alt while dragging, or turn on “Select Text in Mouse-Aware Apps”.'
        ),
    actionLabel: translate(
      'components.terminalPane.MouseReportingCopyHint.openSetting',
      'Open Setting'
    ),
    onAction: deps.openSetting
  })
  return true
}

export function resetMouseReportingCopyHintForTests(): void {
  lastShownAt = Number.NEGATIVE_INFINITY
}
