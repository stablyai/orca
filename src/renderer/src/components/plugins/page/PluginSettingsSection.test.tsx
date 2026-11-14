// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PluginSettingsSection } from './PluginSettingsSection'

const values: Record<string, unknown> = { verbose: false }
const setSetting = vi.fn(async ({ key, value }: { key: string; value: unknown }) => {
  values[key] = value
  return { ok: true as const }
})

beforeEach(() => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      plugins: {
        getSettings: vi.fn(async () => ({
          settings: [
            { key: 'verbose', title: 'Verbose logs', type: 'boolean', default: false },
            { key: 'apiUrl', title: 'Server URL', type: 'string', description: 'Where todos sync' }
          ],
          values: { ...values }
        })),
        setSetting
      }
    }
  })
})

afterEach(() => {
  cleanup()
  setSetting.mockClear()
})

it('shows declared settings and writes what the person changes', async () => {
  render(<PluginSettingsSection pluginKey="acme.todos" revision="1" />)
  expect(await screen.findByText('Verbose logs')).toBeTruthy()
  expect(screen.getByText('Where todos sync')).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('switch'))
  })
  expect(setSetting).toHaveBeenCalledWith({ pluginKey: 'acme.todos', key: 'verbose', value: true })
  const url = screen.getByLabelText('Server URL')
  fireEvent.change(url, { target: { value: 'https://todo.example' } })
  // Typing alone writes nothing; leaving the field does.
  expect(setSetting).toHaveBeenCalledTimes(1)
  await act(async () => {
    fireEvent.blur(url)
  })
  expect(setSetting).toHaveBeenLastCalledWith({
    pluginKey: 'acme.todos',
    key: 'apiUrl',
    value: 'https://todo.example'
  })
})
