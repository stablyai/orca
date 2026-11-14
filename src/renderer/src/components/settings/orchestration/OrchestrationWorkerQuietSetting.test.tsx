// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { OrchestrationWorkerQuietSetting } from './OrchestrationWorkerQuietSetting'

afterEach(cleanup)

it('records inherited Off as a choice and resets only on the explicit default action', () => {
  let settings = getDefaultSettings('~')
  const write = vi.fn((updates: Partial<GlobalSettings>) => {
    settings = { ...settings, ...updates }
    view.rerender(<OrchestrationWorkerQuietSetting settings={settings} updateSettings={write} />)
  })
  const view = render(
    <OrchestrationWorkerQuietSetting settings={settings} updateSettings={write} />
  )
  expect(write).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
  expect(settings.orchestrationQuietWorkerMinutes).toBe(0)
  expect(write).toHaveBeenLastCalledWith({ orchestrationQuietWorkerMinutes: 0 })
  fireEvent.click(screen.getByRole('button', { name: 'Use default' }))
  expect(settings.orchestrationQuietWorkerMinutes).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: 'After' }))
  expect(settings.orchestrationQuietWorkerMinutes).toBe(15)
  fireEvent.change(screen.getByRole('textbox', { name: 'Minutes' }), { target: { value: '23' } })
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Minutes' }), { key: 'Enter' })
  expect(settings.orchestrationQuietWorkerMinutes).toBe(23)
  write.mockClear()
  for (const value of ['', '1.5', '-1', '0', '18764998448', '1e3']) {
    fireEvent.change(screen.getByRole('textbox', { name: 'Minutes' }), { target: { value } })
    fireEvent.blur(screen.getByRole('textbox', { name: 'Minutes' }))
  }
  expect(write).not.toHaveBeenCalled()
  expect(settings.orchestrationQuietWorkerMinutes).toBe(23)
})
