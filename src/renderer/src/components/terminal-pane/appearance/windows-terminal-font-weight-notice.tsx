import { useEffect } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { buildFontFamily } from '@/lib/monospace-font-family'
import { SettingsSegmentedControl } from '../../settings/form-controls/SettingsFormControls'
import { DEFAULT_TERMINAL_FONT_WEIGHT } from '../../../../../shared/terminal/appearance/terminal-fonts'
import { WINDOWS_TERMINAL_FONT_WEIGHT } from '../../../../../shared/terminal/appearance/terminal-platform-defaults'

const TOAST_ID = 'windows-terminal-font-weight'
const SAMPLE_TEXT = 'git status'
const PROBE_TEXT = 'git status 0Oo1lI WMQ@#{}'
const CHOICE_WEIGHTS: readonly number[] = [
  WINDOWS_TERMINAL_FONT_WEIGHT,
  DEFAULT_TERMINAL_FONT_WEIGHT
]

/** Canvas rasterizes like the terminal glyph atlas, so equal pixels mean both weights pick one face. */
function weightsRenderAlike(fontFamily: string, first: number, second: number): boolean {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 48
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    return false
  }
  const rasterize = (weight: number): Uint8ClampedArray => {
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.font = `${weight} 32px ${fontFamily}`
    context.fillText(PROBE_TEXT, 0, 36)
    return context.getImageData(0, 0, canvas.width, canvas.height).data
  }
  const firstPixels = rasterize(first)
  const secondPixels = rasterize(second)
  return firstPixels.every((value, index) => value === secondPixels[index])
}

function finishNotice(): void {
  const store = useAppStore.getState()
  if (store.settings?.terminalFontWeightWindowsRegular !== 'notice-pending') {
    return
  }
  void store.updateSettings({ terminalFontWeightWindowsRegular: 'done' }).catch(console.error)
}

function TerminalFontWeightChoice(): React.JSX.Element {
  const weight = useAppStore((s) => s.settings?.terminalFontWeight ?? WINDOWS_TERMINAL_FONT_WEIGHT)
  const fontFamily = useAppStore((s) => buildFontFamily(s.settings?.terminalFontFamily ?? ''))
  const choices = [
    {
      weight: WINDOWS_TERMINAL_FONT_WEIGHT,
      label: translate('terminal.windowsFontWeight.choiceNew', 'New')
    },
    {
      weight: DEFAULT_TERMINAL_FONT_WEIGHT,
      label: translate('terminal.windowsFontWeight.choicePrevious', 'Previous')
    }
  ]
  return (
    <div className="mt-2">
      <SettingsSegmentedControl
        value={weight}
        equalWidth
        ariaLabel={translate('terminal.windowsFontWeight.choiceLabel', 'Terminal font weight')}
        onChange={(terminalFontWeight) =>
          void useAppStore.getState().updateSettings({ terminalFontWeight }).catch(console.error)
        }
        options={choices.map((choice) => ({
          value: choice.weight,
          label: (
            <span className="flex flex-col items-center gap-0.5 py-0.5">
              <span className="text-lg" style={{ fontFamily, fontWeight: choice.weight }}>
                {SAMPLE_TEXT}
              </span>
              <span className="text-xs">
                {choice.label} · {choice.weight}
              </span>
            </span>
          )
        }))}
      />
    </div>
  )
}

/** One persistent choice for Windows profiles moved off the old 500 default; it returns until Okay or close. */
export function useWindowsTerminalFontWeightNotice(): void {
  const noticePending = useAppStore(
    (s) => s.settings?.terminalFontWeightWindowsRegular === 'notice-pending'
  )
  const weightChosenElsewhere = useAppStore(
    (s) => noticePending && !CHOICE_WEIGHTS.includes(s.settings?.terminalFontWeight ?? Number.NaN)
  )

  // A weight set in Settings supersedes the choice offered here.
  useEffect(() => {
    if (weightChosenElsewhere) {
      finishNotice()
    }
  }, [weightChosenElsewhere])

  useEffect(() => {
    if (!noticePending) {
      toast.dismiss(TOAST_ID)
      return
    }
    const fontFamily = buildFontFamily(useAppStore.getState().settings?.terminalFontFamily ?? '')
    // Fonts without a Medium face render both weights identically, so there is nothing to choose.
    if (
      weightsRenderAlike(fontFamily, WINDOWS_TERMINAL_FONT_WEIGHT, DEFAULT_TERMINAL_FONT_WEIGHT)
    ) {
      finishNotice()
      return
    }
    toast(
      translate('terminal.windowsFontWeight.title', 'Terminal text on Windows is now lighter'),
      {
        // A stable ID lets sonner dedupe StrictMode's repeat.
        id: TOAST_ID,
        description: <TerminalFontWeightChoice />,
        duration: Infinity,
        onDismiss: finishNotice,
        action: {
          label: translate('terminal.windowsFontWeight.okay', 'Okay'),
          // Sonner actions skip onDismiss, so consume the notice here too.
          onClick: finishNotice
        }
      }
    )
  }, [noticePending])
}
