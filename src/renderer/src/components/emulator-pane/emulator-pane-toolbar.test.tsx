// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EmulatorPaneToolbar } from './emulator-pane-toolbar'
import {
  AndroidEmulatorToolbarControls,
  POWER_LONG_PRESS_MS
} from './android-emulator-toolbar-controls'

const capabilities = {
  shutdown: true,
  power: true,
  volume: true,
  overview: true,
  foldable: true,
  wearButton1: true,
  wearButton2: true
} as const

function renderControls(
  overrides: Partial<React.ComponentProps<typeof AndroidEmulatorToolbarControls>> = {}
) {
  const onButton = vi.fn()
  const onPosture = vi.fn()
  const onRotate = vi.fn()
  const onScreenshot = vi.fn()
  const onZoomChange = vi.fn()
  render(
    <TooltipProvider>
      <AndroidEmulatorToolbarControls
        capabilities={capabilities}
        disabled={false}
        displayCommandPending={false}
        screenshotAvailable
        savingScreenshot={false}
        zoomPercentage={100}
        zoomAvailability={{ in: true, out: true, actual: true, fit: true, 'fit-display': true }}
        onButton={onButton}
        onPosture={onPosture}
        onRotate={onRotate}
        onScreenshot={onScreenshot}
        onZoomChange={onZoomChange}
        {...overrides}
      />
    </TooltipProvider>
  )
  return { onButton, onPosture, onRotate, onScreenshot, onZoomChange }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('AndroidEmulatorToolbarControls', () => {
  it('exposes the standard labels and disables every action before live session', () => {
    renderControls({ disabled: true })

    for (const name of [
      'Power',
      'Volume Up',
      'Volume Down',
      'Rotate Left',
      'Rotate Right',
      'Take Screenshot',
      'Zoom',
      'Back',
      'Home',
      'Overview',
      'Fold',
      'Unfold',
      'Button 1',
      'Button 2'
    ]) {
      expect(
        screen.getAllByRole('button', { name }).every((button) => button.hasAttribute('disabled'))
      ).toBe(true)
    }
  })

  it('keeps Power short and long press mutually exclusive and supports keyboard short press', () => {
    const { onButton } = renderControls()
    const power = screen.getAllByRole('button', { name: 'Power' })[0]

    fireEvent.pointerDown(power, { pointerId: 1 })
    vi.advanceTimersByTime(POWER_LONG_PRESS_MS - 1)
    fireEvent.pointerUp(power, { pointerId: 1 })
    expect(onButton).toHaveBeenLastCalledWith('power')
    expect(onButton).toHaveBeenCalledTimes(1)

    fireEvent.pointerDown(power, { pointerId: 1 })
    vi.advanceTimersByTime(POWER_LONG_PRESS_MS)
    expect(onButton).toHaveBeenLastCalledWith('power', { longPress: true })
    fireEvent.pointerUp(power, { pointerId: 1 })
    expect(onButton).toHaveBeenCalledTimes(2)
    fireEvent.click(power)
    expect(onButton).toHaveBeenCalledTimes(2)
    fireEvent.click(power)
    expect(onButton).toHaveBeenCalledTimes(3)
    expect(onButton).toHaveBeenLastCalledWith('power')
  })

  it('cancels a Power long press when the pointer leaves before the timeout', () => {
    const { onButton } = renderControls()
    const power = screen.getAllByRole('button', { name: 'Power' })[0]

    fireEvent.pointerDown(power, { pointerId: 1 })
    fireEvent.pointerLeave(power, { pointerId: 1 })
    vi.advanceTimersByTime(POWER_LONG_PRESS_MS)

    expect(onButton).not.toHaveBeenCalled()

    fireEvent.click(power)

    expect(onButton).toHaveBeenCalledTimes(1)
    expect(onButton).toHaveBeenLastCalledWith('power')
  })

  it('gates Wear and foldable controls by capabilities', () => {
    renderControls({
      capabilities: {
        ...capabilities,
        power: false,
        volume: false,
        overview: false,
        foldable: false,
        wearButton1: true,
        wearButton2: false
      }
    })

    expect(screen.queryAllByRole('button', { name: 'Power' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: 'Volume Up' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: 'Overview' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: 'Fold' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: 'Button 1' })).not.toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: 'Button 2' })).toHaveLength(0)
  })
})

describe('EmulatorPaneToolbar Android shutdown fallback', () => {
  function renderToolbar(runtime: string) {
    render(
      <TooltipProvider>
        <EmulatorPaneToolbar
          displayName="Pixel"
          isLive
          loading={false}
          devices={[{ name: 'Pixel', udid: 'emulator-5554', state: 'Booted', runtime }]}
          selectedUdid="emulator-5554"
          backend="android"
          androidControls={{
            displayCommandPending: false,
            screenshotAvailable: true,
            savingScreenshot: false,
            zoomPercentage: 100,
            zoomAvailability: { in: true, out: true, actual: true, fit: true, 'fit-display': true },
            onButton: vi.fn(),
            onPosture: vi.fn(),
            onRotate: vi.fn(),
            onScreenshot: vi.fn(),
            onZoomChange: vi.fn()
          }}
          onSelectDevice={vi.fn()}
          onAttach={vi.fn()}
          onShutdown={vi.fn()}
          onHome={vi.fn()}
          onRotate={vi.fn()}
        />
      </TooltipProvider>
    )
  }

  it('hides shutdown for physical-device rows', () => {
    renderToolbar('device')
    expect(screen.queryByRole('button', { name: 'Shut down emulator' })).toBeNull()
  })

  it('shows shutdown for legacy emulator rows', () => {
    renderToolbar('emulator')
    expect(screen.getByRole('button', { name: 'Shut down emulator' })).toBeTruthy()
  })
})
