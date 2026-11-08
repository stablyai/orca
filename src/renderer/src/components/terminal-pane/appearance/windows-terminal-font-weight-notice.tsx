import { useEffect, useId, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { buildFontFamily } from '@/lib/monospace-font-family'
import { isWindowsDesktopClient } from '@/lib/windows-path-access'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { DEFAULT_TERMINAL_FONT_WEIGHT } from '../../../../../shared/terminal/appearance/terminal-fonts'
import { WINDOWS_TERMINAL_FONT_WEIGHT } from '../../../../../shared/terminal/appearance/terminal-platform-defaults'

const TOAST_ID = 'windows-terminal-font-weight'
const SAMPLE_TEXT = 'git status --short'
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
  const rasterize = (weight: number): Uint8ClampedArray | null => {
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.font = '1px serif'
    const rejected = context.font
    context.font = `${weight} 32px ${fontFamily}`
    // An unparsable family leaves the sentinel font, which would compare equal and hide the notice.
    if (context.font === rejected) {
      return null
    }
    context.fillText(PROBE_TEXT, 0, 36)
    return context.getImageData(0, 0, canvas.width, canvas.height).data
  }
  const firstPixels = rasterize(first)
  const secondPixels = rasterize(second)
  if (!firstPixels || !secondPixels) {
    return false
  }
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
  const t = useTranslate()
  const switchId = useId()
  const weight = useAppStore((s) => s.settings?.terminalFontWeight ?? WINDOWS_TERMINAL_FONT_WEIGHT)
  const fontFamily = useAppStore((s) => buildFontFamily(s.settings?.terminalFontFamily ?? ''))
  const fontSize = useAppStore((s) => s.settings?.terminalFontSize)
  return (
    // Sonner treats a drag that starts outside a button as a swipe; keep it from dismissing mid-choice.
    <div className="mt-2 space-y-2" onPointerDown={(event) => event.stopPropagation()}>
      <div
        aria-hidden
        className="truncate rounded-md border border-border/70 bg-muted/35 px-2.5 py-1.5 text-sm text-popover-foreground"
        style={{ fontFamily, fontSize, fontWeight: weight }}
      >
        {SAMPLE_TEXT}
      </div>
      <div className="flex items-center justify-between gap-3 text-sm text-popover-foreground">
        <Label htmlFor={switchId}>
          {t('terminal.windowsFontWeight.lighterText', 'Lighter terminal text')}
        </Label>
        <Switch
          id={switchId}
          checked={weight === WINDOWS_TERMINAL_FONT_WEIGHT}
          onCheckedChange={(lighter) =>
            void useAppStore
              .getState()
              .updateSettings({
                terminalFontWeight: lighter
                  ? WINDOWS_TERMINAL_FONT_WEIGHT
                  : DEFAULT_TERMINAL_FONT_WEIGHT
              })
              .catch(console.error)
          }
        />
      </div>
    </div>
  )
}

/** One persistent choice for Windows profiles moved off the old 500 default; it returns until Okay or close. */
export function useWindowsTerminalFontWeightNotice(persistedUIReady: boolean): void {
  // The probe measures this client's fonts, so only the Windows desktop may settle the notice.
  const noticePending = useAppStore(
    (s) =>
      persistedUIReady &&
      isWindowsDesktopClient() &&
      s.settings?.terminalFontWeightWindowsRegular === 'notice-pending'
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

  const shownRef = useRef(false)

  useEffect(() => {
    if (!noticePending) {
      // Sonner defers dismissal, so an unconditional one would close the toast shown right after hydration.
      if (shownRef.current) {
        shownRef.current = false
        toast.dismiss(TOAST_ID)
      }
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
    shownRef.current = true
    toast(
      translate('terminal.windowsFontWeight.title', 'Terminal text on Windows is now lighter'),
      {
        // A stable ID lets sonner dedupe StrictMode's repeat.
        id: TOAST_ID,
        description: <TerminalFontWeightChoice />,
        duration: Infinity,
        // The global footer rule indents actions past a status icon; this toast has none and keeps Okay at the end.
        classNames: { actionButton: '!ml-auto' },
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
