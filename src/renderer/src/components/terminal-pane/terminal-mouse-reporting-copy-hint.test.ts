import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MOUSE_REPORTING_COPY_HINT_COOLDOWN_MS,
  maybeShowMouseReportingCopyHint,
  resetMouseReportingCopyHintForTests,
  type MouseReportingCopyHintDeps
} from './terminal-mouse-reporting-copy-hint'

type MouseTrackingMode = 'none' | 'x10' | 'vt200' | 'drag' | 'any'

function terminal(
  mouseTrackingMode: MouseTrackingMode,
  mouseEventsRequireAlt = false
): {
  modes: { mouseTrackingMode: MouseTrackingMode }
  options: { mouseEventsRequireAlt: boolean }
} {
  return { modes: { mouseTrackingMode }, options: { mouseEventsRequireAlt } }
}

function deps(now: () => number): {
  now: () => number
  showToast: ReturnType<typeof vi.fn<MouseReportingCopyHintDeps['showToast']>>
  openSetting: ReturnType<typeof vi.fn<MouseReportingCopyHintDeps['openSetting']>>
} {
  return {
    now,
    showToast: vi.fn<MouseReportingCopyHintDeps['showToast']>(),
    openSetting: vi.fn<MouseReportingCopyHintDeps['openSetting']>()
  }
}

describe('maybeShowMouseReportingCopyHint', () => {
  beforeEach(() => {
    resetMouseReportingCopyHintForTests()
  })

  it('stays silent when the app does not report the mouse', () => {
    const d = deps(() => 1_000)
    expect(maybeShowMouseReportingCopyHint(terminal('none'), true, d)).toBe(false)
    expect(d.showToast).not.toHaveBeenCalled()
  })

  it('explains the empty copy when a TUI owns the mouse', () => {
    const d = deps(() => 1_000)
    expect(maybeShowMouseReportingCopyHint(terminal('any'), true, d)).toBe(true)
    expect(d.showToast).toHaveBeenCalledTimes(1)
    const args = d.showToast.mock.calls[0]?.[0]
    expect(args?.description).toContain('Hold Option')
    args?.onAction()
    expect(d.openSetting).toHaveBeenCalledTimes(1)
  })

  it('names Shift, the xterm force-selection modifier, off macOS', () => {
    const d = deps(() => 1_000)
    maybeShowMouseReportingCopyHint(terminal('vt200'), false, d)
    const description = d.showToast.mock.calls[0]?.[0]?.description ?? ''
    expect(description).toContain('Hold Shift')
    expect(description).not.toContain('Option')
  })

  it('stays silent once the setting already hands drags to xterm', () => {
    const d = deps(() => 1_000)
    expect(maybeShowMouseReportingCopyHint(terminal('any', true), true, d)).toBe(false)
    expect(d.showToast).not.toHaveBeenCalled()
  })

  it('rate-limits repeated presses, then shows again after the cooldown', () => {
    let clock = 5_000
    const d = deps(() => clock)
    expect(maybeShowMouseReportingCopyHint(terminal('drag'), true, d)).toBe(true)
    clock += MOUSE_REPORTING_COPY_HINT_COOLDOWN_MS - 1
    expect(maybeShowMouseReportingCopyHint(terminal('drag'), true, d)).toBe(false)
    clock += 1
    expect(maybeShowMouseReportingCopyHint(terminal('drag'), true, d)).toBe(true)
    expect(d.showToast).toHaveBeenCalledTimes(2)
  })
})
