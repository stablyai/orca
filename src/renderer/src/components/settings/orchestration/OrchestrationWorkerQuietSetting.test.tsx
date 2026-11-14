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
  const input = screen.getByRole('textbox', { name: 'Minutes' })
  input.focus()
  fireEvent.change(input, { target: { value: '5' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.blur(input)
  expect(settings.orchestrationQuietWorkerMinutes).toBeNull()
  fireEvent.click(screen.getByRole('radio', { name: 'After' }))
  expect(settings.orchestrationQuietWorkerMinutes).toBe(5)
  fireEvent.change(screen.getByRole('textbox', { name: 'Minutes' }), { target: { value: '23' } })
  input.focus()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(settings.orchestrationQuietWorkerMinutes).toBe(23)
  expect(document.activeElement).toBe(input)
  fireEvent.change(input, { target: { value: 'invalid' } })
  fireEvent.blur(input)
  fireEvent.click(screen.getByRole('radio', { name: 'Off' }))
  expect(settings.orchestrationQuietWorkerMinutes).toBe(0)
  fireEvent.click(screen.getByRole('radio', { name: 'After' }))
  expect(settings.orchestrationQuietWorkerMinutes).toBe(23)
  write.mockClear()
  for (const value of ['', '1.5', '-1', '0', '18764998448', '1e3']) {
    fireEvent.change(screen.getByRole('textbox', { name: 'Minutes' }), { target: { value } })
    fireEvent.blur(screen.getByRole('textbox', { name: 'Minutes' }))
  }
  expect(write).not.toHaveBeenCalled()
  expect(settings.orchestrationQuietWorkerMinutes).toBe(23)
})

it.each([
  ['Off', 0],
  ['Use default', null]
] as const)('keeps the pressed %s action through an acknowledged blur save', (action, expected) => {
  let settings: GlobalSettings = { ...getDefaultSettings('~'), orchestrationQuietWorkerMinutes: 15 }
  const write = (updates: Partial<GlobalSettings>) => {
    settings = { ...settings, ...updates }
    view.rerender(<OrchestrationWorkerQuietSetting settings={settings} updateSettings={write} />)
  }
  const view = render(
    <OrchestrationWorkerQuietSetting settings={settings} updateSettings={write} />
  )
  const input = screen.getByRole('textbox', { name: 'Minutes' })
  const button = screen.getByRole(action === 'Off' ? 'radio' : 'button', { name: action })
  input.focus()
  fireEvent.change(input, { target: { value: '23' } })
  fireEvent.mouseDown(button)
  fireEvent.blur(input, { relatedTarget: button })
  expect(settings.orchestrationQuietWorkerMinutes).toBe(23)
  fireEvent.mouseUp(button)
  fireEvent.click(button)
  expect(settings.orchestrationQuietWorkerMinutes).toBe(expected)
})
