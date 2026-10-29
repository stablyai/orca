// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MacCapturedDigitRowChord,
  MacDigitRowCode
} from '../../../../shared/macos-symbolic-hotkeys'
import type { LayoutMapLike } from '@/lib/keyboard-layout/detect-option-as-alt'
import { useMacCapturedDigitChords } from './use-mac-captured-digit-chords'

const PHYSICAL_CTRL_ONE: MacCapturedDigitRowChord = {
  code: 'Digit1',
  meta: false,
  control: true,
  alt: false,
  shift: false
}

function layoutMap(entries: [MacDigitRowCode, string][]): LayoutMapLike {
  return new Map<string, string>(entries)
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

afterEach(cleanup)

describe('useMacCapturedDigitChords', () => {
  it('reads immediately and clears the warning after a focus refresh', async () => {
    const readSystemChords = vi
      .fn()
      .mockResolvedValueOnce([PHYSICAL_CTRL_ONE])
      .mockResolvedValueOnce([])
    const readLayoutMap = vi.fn().mockResolvedValue(layoutMap([['Digit1', '1']]))
    const hook = renderHook(() =>
      useMacCapturedDigitChords({ enabled: true, readSystemChords, readLayoutMap })
    )

    await waitFor(() => expect(hook.result.current).toHaveLength(1))
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(hook.result.current).toEqual([]))

    expect(readSystemChords).toHaveBeenCalledTimes(2)
    expect(readLayoutMap).toHaveBeenCalledTimes(2)
  })

  it('stays silent when the active layout does not produce a digit', async () => {
    const readSystemChords = async (): Promise<MacCapturedDigitRowChord[]> => [PHYSICAL_CTRL_ONE]
    const readLayoutMap = async (): Promise<LayoutMapLike> => layoutMap([['Digit1', '&']])
    const hook = renderHook(() =>
      useMacCapturedDigitChords({
        enabled: true,
        readSystemChords,
        readLayoutMap
      })
    )

    await waitFor(() => expect(hook.result.current).toEqual([]))
  })

  it('clears a prior result when the system probe rejects', async () => {
    const readSystemChords = vi
      .fn()
      .mockResolvedValueOnce([PHYSICAL_CTRL_ONE])
      .mockRejectedValueOnce(new Error('unavailable'))
    const readLayoutMap = async (): Promise<LayoutMapLike> => layoutMap([['Digit1', '1']])
    const hook = renderHook(() =>
      useMacCapturedDigitChords({
        enabled: true,
        readSystemChords,
        readLayoutMap
      })
    )

    await waitFor(() => expect(hook.result.current).toHaveLength(1))
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(hook.result.current).toEqual([]))
  })

  it('clears a prior result when the layout-map probe rejects', async () => {
    const readSystemChords = vi.fn().mockResolvedValue([PHYSICAL_CTRL_ONE])
    const readLayoutMap = vi
      .fn()
      .mockResolvedValueOnce(layoutMap([['Digit1', '1']]))
      .mockRejectedValueOnce(new Error('layout unavailable'))
    const hook = renderHook(() =>
      useMacCapturedDigitChords({ enabled: true, readSystemChords, readLayoutMap })
    )

    await waitFor(() => expect(hook.result.current).toHaveLength(1))
    act(() => window.dispatchEvent(new Event('focus')))
    await waitFor(() => expect(hook.result.current).toEqual([]))
  })

  it('coalesces focus events into one trailing refresh', async () => {
    const older = deferred<MacCapturedDigitRowChord[]>()
    const newer = deferred<MacCapturedDigitRowChord[]>()
    const readSystemChords = vi
      .fn()
      .mockResolvedValueOnce([PHYSICAL_CTRL_ONE])
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise)
    const readLayoutMap = async (): Promise<LayoutMapLike> => layoutMap([['Digit1', '1']])
    const hook = renderHook(() =>
      useMacCapturedDigitChords({
        enabled: true,
        readSystemChords,
        readLayoutMap
      })
    )

    await waitFor(() => expect(hook.result.current).toHaveLength(1))
    act(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('focus'))
    })
    expect(readSystemChords).toHaveBeenCalledTimes(2)
    await act(async () => older.resolve([]))
    await waitFor(() => expect(readSystemChords).toHaveBeenCalledTimes(3))
    expect(hook.result.current).toHaveLength(1)
    await act(async () => newer.resolve([]))
    expect(hook.result.current).toEqual([])
  })

  it('removes the focus listener when unmounted', async () => {
    const readSystemChords = vi.fn().mockResolvedValue([PHYSICAL_CTRL_ONE])
    const readLayoutMap = async (): Promise<LayoutMapLike> => layoutMap([['Digit1', '1']])
    const hook = renderHook(() =>
      useMacCapturedDigitChords({
        enabled: true,
        readSystemChords,
        readLayoutMap
      })
    )
    await waitFor(() => expect(readSystemChords).toHaveBeenCalledOnce())

    hook.unmount()
    window.dispatchEvent(new Event('focus'))

    expect(readSystemChords).toHaveBeenCalledOnce()
  })
})
