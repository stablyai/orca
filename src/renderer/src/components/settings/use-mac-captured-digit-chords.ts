import { useEffect, useState } from 'react'
import {
  resolveCapturedDigitChordsForLayout,
  type MacCapturedDigitChord,
  type MacCapturedDigitRowChord
} from '../../../../shared/macos-symbolic-hotkeys'
import type { LayoutMapLike } from '@/lib/keyboard-layout/detect-option-as-alt'
import { normalizeLayoutBaseCharacter } from '@/lib/keyboard-layout/layout-base-character'

type SystemChordReader = (win: Window) => Promise<MacCapturedDigitRowChord[]>
type LayoutMapReader = (win: Window) => Promise<LayoutMapLike | null>

type UseMacCapturedDigitChordsOptions = {
  enabled: boolean
  win?: Window
  readSystemChords?: SystemChordReader
  readLayoutMap?: LayoutMapReader
}

const EMPTY_CHORDS: readonly MacCapturedDigitChord[] = []

function defaultSystemChordReader(win: Window): Promise<MacCapturedDigitRowChord[]> {
  return win.api.app.getMacCapturedDigitRowChords()
}

async function defaultLayoutMapReader(win: Window): Promise<LayoutMapLike | null> {
  const navigatorWithKeyboard = win.navigator as Navigator & {
    keyboard?: { getLayoutMap: () => Promise<LayoutMapLike> }
  }
  return navigatorWithKeyboard.keyboard?.getLayoutMap() ?? null
}

async function readCapturedDigitChords(
  win: Window,
  readSystemChords: SystemChordReader,
  readLayoutMap: LayoutMapReader
): Promise<readonly MacCapturedDigitChord[]> {
  try {
    const [physicalChords, layoutMap] = await Promise.all([
      readSystemChords(win),
      readLayoutMap(win)
    ])
    if (!layoutMap) {
      return EMPTY_CHORDS
    }
    return resolveCapturedDigitChordsForLayout(physicalChords, (code) =>
      normalizeLayoutBaseCharacter(layoutMap.get(code))
    )
  } catch {
    return EMPTY_CHORDS
  }
}

export function useMacCapturedDigitChords({
  enabled,
  win = window,
  readSystemChords = defaultSystemChordReader,
  readLayoutMap = defaultLayoutMapReader
}: UseMacCapturedDigitChordsOptions): readonly MacCapturedDigitChord[] {
  const [chords, setChords] = useState<readonly MacCapturedDigitChord[]>(EMPTY_CHORDS)

  // Probe OS-owned chords that never reach the renderer.
  useEffect(() => {
    if (!enabled) {
      return
    }
    let disposed = false
    let probing = false
    let refreshPending = false
    const refresh = async (): Promise<void> => {
      if (probing) {
        refreshPending = true
        return
      }
      probing = true
      do {
        refreshPending = false
        const next = await readCapturedDigitChords(win, readSystemChords, readLayoutMap)
        if (!disposed && !refreshPending) {
          setChords(next)
        }
      } while (!disposed && refreshPending)
      probing = false
    }
    const onFocus = (): void => {
      void refresh()
    }
    win.addEventListener('focus', onFocus)
    void refresh()
    return () => {
      disposed = true
      win.removeEventListener('focus', onFocus)
    }
  }, [enabled, readLayoutMap, readSystemChords, win])

  return chords
}
