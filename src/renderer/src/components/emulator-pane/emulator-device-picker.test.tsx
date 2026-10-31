// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EmulatorDevicePicker } from './emulator-device-picker'

afterEach(cleanup)

describe('EmulatorDevicePicker', () => {
  it('reveals other devices during search, keeps unavailable rows disabled, and selects the exact duplicate', async () => {
    const onSelect = vi.fn()
    render(
      <EmulatorDevicePicker
        selectedUdid="active"
        onSelectDevice={onSelect}
        devices={[
          { name: 'Pixel', udid: 'active', state: 'Booted', backend: 'android' },
          {
            name: 'iPhone',
            udid: 'old',
            state: 'Shutdown',
            runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0',
            isAvailable: false,
            availabilityError: 'Missing runtime'
          },
          {
            name: 'iPhone',
            udid: 'new',
            state: 'Shutdown',
            runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-27-2'
          }
        ]}
      />
    )
    fireEvent.click(screen.getByRole('combobox'))
    expect(screen.queryByText('iPhone')).toBeNull()
    fireEvent.change(screen.getByPlaceholderText('Search devices…'), {
      target: { value: 'iPhone' }
    })
    await waitFor(() => expect(screen.getAllByText('iPhone')).toHaveLength(2))
    const unavailable = screen.getByText('Missing runtime').closest('[cmdk-item]')
    expect(unavailable?.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(unavailable!)
    expect(onSelect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('iOS 27.2 · Stopped'))
    expect(onSelect).toHaveBeenCalledWith('new')
    await waitFor(() => expect(screen.queryByPlaceholderText('Search devices…')).toBeNull())
  })
})
