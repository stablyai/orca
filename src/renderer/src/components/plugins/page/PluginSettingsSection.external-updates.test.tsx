// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PluginSettingsSection } from './PluginSettingsSection'

const snapshot = (apiUrl: string) => ({
  settings: [{ key: 'apiUrl', title: 'Server URL', type: 'string' as const, default: '' }],
  values: { apiUrl }
})
const getSettings = vi.fn()
const setSetting = vi.fn()

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue(snapshot(''))
  setSetting.mockReset().mockResolvedValue({ ok: true })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { plugins: { getSettings, setSetting } }
  })
})
afterEach(cleanup)

it('drops a draft invalidated by a plugin reset even when the stored value was already the default', async () => {
  const { rerender } = render(
    <PluginSettingsSection pluginKey="acme.todos" revision="1" settingsRevision={0} />
  )
  const input = await screen.findByLabelText<HTMLInputElement>('Server URL')
  input.focus()
  fireEvent.change(input, { target: { value: 'https://obsolete.example' } })
  rerender(
    <PluginSettingsSection
      pluginKey="acme.todos"
      revision="1"
      settingsRevision={1}
      draftRevisions={{ apiUrl: 1 }}
    />
  )
  await waitFor(() => expect(input.value).toBe(''))
  expect(document.activeElement).toBe(input)
  fireEvent.blur(input)
  expect(setSetting).not.toHaveBeenCalled()
})

it('keeps focus and the next draft when an own settings save triggers a refresh', async () => {
  let finishWrite!: (result: { ok: true }) => void
  setSetting.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishWrite = resolve
      })
  )
  const { rerender } = render(
    <PluginSettingsSection pluginKey="acme.todos" revision="1" settingsRevision={0} />
  )
  const input = await screen.findByLabelText<HTMLInputElement>('Server URL')
  input.focus()
  fireEvent.change(input, { target: { value: 'https://saved.example' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.change(input, { target: { value: 'https://next.example' } })
  getSettings.mockResolvedValue(snapshot('https://saved.example'))
  rerender(<PluginSettingsSection pluginKey="acme.todos" revision="1" settingsRevision={1} />)
  await act(async () => {
    finishWrite({ ok: true })
  })
  expect(input.value).toBe('https://next.example')
  expect(document.activeElement).toBe(input)
  fireEvent.blur(input)
  await waitFor(() =>
    expect(setSetting).toHaveBeenLastCalledWith({
      pluginKey: 'acme.todos',
      key: 'apiUrl',
      value: 'https://next.example'
    })
  )
})

it('does not restore an obsolete save read after a newer plugin reset has loaded', async () => {
  let finishObsoleteRead!: (value: ReturnType<typeof snapshot>) => void
  getSettings.mockResolvedValueOnce(snapshot('https://before.example'))
  const { rerender } = render(
    <PluginSettingsSection pluginKey="acme.todos" revision="1" settingsRevision={0} />
  )
  const input = await screen.findByLabelText<HTMLInputElement>('Server URL')
  getSettings.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishObsoleteRead = resolve
      })
  )
  await act(async () => {
    fireEvent.change(input, { target: { value: 'https://saved.example' } })
    fireEvent.keyDown(input, { key: 'Enter' })
  })
  getSettings.mockResolvedValue(snapshot(''))
  rerender(
    <PluginSettingsSection
      pluginKey="acme.todos"
      revision="1"
      settingsRevision={1}
      draftRevisions={{ apiUrl: 1 }}
    />
  )
  await waitFor(() => expect(input.value).toBe(''))
  await act(async () => {
    finishObsoleteRead(snapshot('https://saved.example'))
  })
  expect(input.value).toBe('')
})
