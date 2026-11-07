import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { buildFontFamily } from '@/lib/monospace-font-family'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { DEFAULT_TERMINAL_FONT_WEIGHT } from '../../../../../shared/terminal/appearance/terminal-fonts'
import { WINDOWS_TERMINAL_FONT_WEIGHT } from '../../../../../shared/terminal/appearance/terminal-platform-defaults'
import { TERMINAL_FONT_WEIGHT_SETTING_ID } from '../../settings/terminal/appearance/terminal-typography-search'

const WEIGHT_SAMPLE_TEXT = 'git status --short'

function openTerminalFontWeightSetting(): void {
  const store = useAppStore.getState()
  store.openSettingsPage()
  store.openSettingsTarget({
    pane: 'appearance',
    repoId: null,
    sectionId: TERMINAL_FONT_WEIGHT_SETTING_ID
  })
}

function TerminalWeightSamples({ fontFamily }: { fontFamily: string }): React.JSX.Element {
  const samples = [
    {
      weight: WINDOWS_TERMINAL_FONT_WEIGHT,
      label: translate('terminal.windowsFontWeight.sampleNow', 'Now')
    },
    {
      weight: DEFAULT_TERMINAL_FONT_WEIGHT,
      label: translate('terminal.windowsFontWeight.sampleBefore', 'Before')
    }
  ]
  return (
    <div className="mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1">
      {samples.map(({ weight, label }) => (
        <div key={weight} className="contents">
          <span className="text-xs text-muted-foreground">
            {label} · {weight}
          </span>
          <span
            className="truncate text-sm text-foreground"
            style={{ fontFamily, fontWeight: weight }}
          >
            {WEIGHT_SAMPLE_TEXT}
          </span>
        </div>
      ))}
    </div>
  )
}

const UNDO_TOAST_ID = 'windows-terminal-font-weight-undo'
const NOTICE_TOAST_ID = 'windows-terminal-font-weight-notice'

function finishNotice(updates: Partial<GlobalSettings> = {}): void {
  const store = useAppStore.getState()
  if (store.settings?.terminalFontWeightWindowsRegular !== 'notice-pending') {
    return
  }
  void store
    .updateSettings({ ...updates, terminalFontWeightWindowsRegular: 'done' })
    .catch(console.error)
}

/** Tells Windows profiles moved off the old 500 default, with an Undo that outlives the Adjust action. */
export function useWindowsTerminalFontWeightNotice(): void {
  const noticePending = useAppStore(
    (s) => s.settings?.terminalFontWeightWindowsRegular === 'notice-pending'
  )
  const weightChosenSinceMigration = useAppStore(
    (s) => noticePending && s.settings?.terminalFontWeight !== WINDOWS_TERMINAL_FONT_WEIGHT
  )

  // A weight picked by hand supersedes Undo, which would otherwise overwrite it with 500.
  useEffect(() => {
    if (weightChosenSinceMigration) {
      finishNotice()
    }
  }, [weightChosenSinceMigration])

  useEffect(() => {
    if (!noticePending) {
      toast.dismiss(UNDO_TOAST_ID)
      toast.dismiss(NOTICE_TOAST_ID)
      return
    }
    // Shown first so the explanation stacks on top; it stays after that toast closes.
    toast(
      translate(
        'terminal.windowsFontWeight.undo.title',
        'Terminal font weight changed from 500 to 400'
      ),
      {
        // Stable IDs let sonner dedupe StrictMode's repeat.
        id: UNDO_TOAST_ID,
        duration: Infinity,
        onDismiss: () => finishNotice(),
        action: {
          label: translate('terminal.windowsFontWeight.undo.action', 'Undo'),
          // Sonner actions skip onDismiss, so consume the notice here too.
          onClick: () => finishNotice({ terminalFontWeight: DEFAULT_TERMINAL_FONT_WEIGHT })
        }
      }
    )
    toast.info(
      translate('terminal.windowsFontWeight.notice.title', 'Terminal text is lighter on Windows'),
      {
        id: NOTICE_TOAST_ID,
        description: (
          <>
            {translate(
              'terminal.windowsFontWeight.notice.description',
              'Windows fonts like Cascadia Mono have no Medium face, so 500 drew as SemiBold. Terminals now use Regular.'
            )}
            <TerminalWeightSamples
              fontFamily={buildFontFamily(
                useAppStore.getState().settings?.terminalFontFamily ?? ''
              )}
            />
          </>
        ),
        duration: 15_000,
        action: {
          label: translate('terminal.windowsFontWeight.notice.action', 'Adjust'),
          onClick: openTerminalFontWeightSetting
        }
      }
    )
  }, [noticePending])
}
