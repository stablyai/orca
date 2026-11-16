// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { ProxyTlsSettingsFields } from './ProxyTlsSettingsFields'

afterEach(cleanup)

it('preserves newer certificate edits when a pending save is acknowledged', async () => {
  const pending = Promise.withResolvers<void>()
  const updateSettings = vi.fn(() => pending.promise)
  let settings = { ...getDefaultSettings('/tmp'), httpProxyCaCertificate: 'certificate A' }
  const view = render(
    <ProxyTlsSettingsFields settings={settings} updateSettings={updateSettings} />
  )
  const input = screen.getByRole('textbox', { name: 'Custom CA certificate (PEM)' })

  fireEvent.change(input, { target: { value: 'certificate B' } })
  fireEvent.blur(input)
  expect(updateSettings).toHaveBeenLastCalledWith({ httpProxyCaCertificate: 'certificate B' })
  fireEvent.change(input, { target: { value: 'certificate C' } })

  settings = { ...settings, httpProxyCaCertificate: 'certificate B' }
  view.rerender(<ProxyTlsSettingsFields settings={settings} updateSettings={updateSettings} />)
  expect(screen.getByDisplayValue('certificate C')).toBeTruthy()
  await act(async () => pending.resolve())
  expect(screen.getByDisplayValue('certificate C')).toBeTruthy()

  fireEvent.blur(input)
  expect(updateSettings).toHaveBeenLastCalledWith({ httpProxyCaCertificate: 'certificate C' })
  settings = { ...settings, httpProxyCaCertificate: 'certificate C' }
  await act(async () => {
    view.rerender(<ProxyTlsSettingsFields settings={settings} updateSettings={updateSettings} />)
  })
  settings = { ...settings, httpProxyCaCertificate: 'external certificate' }
  view.rerender(<ProxyTlsSettingsFields settings={settings} updateSettings={updateSettings} />)
  expect(screen.getByDisplayValue('external certificate')).toBeTruthy()
})
