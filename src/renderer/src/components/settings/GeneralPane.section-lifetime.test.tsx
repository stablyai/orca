// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { GeneralPane } from './GeneralPane'
const fake = vi.hoisted(() => ({
  query: '',
  getVersion: vi.fn(async () => '1.4.100'),
  refresh: vi.fn(async () => {}),
  action: vi.fn(),
  updates: new Map([
    ['synthetic-host', { environmentId: 'synthetic-host', phase: 'current', name: 'Synthetic' }]
  ])
}))
vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      settingsSearchQuery: fake.query,
      updateStatus: { state: 'idle' },
      remoteServerUpdates: fake.updates,
      remoteServerUpdatesChecking: false,
      remoteServerUpdatesRunning: false,
      refreshRemoteServerUpdates: fake.refresh,
      setRemoteServerUpdateDialogOpen: fake.action
    })
}))
vi.mock('@/components/settings/GeneralWorkspaceSettingsSection', () => ({
  GeneralWorkspaceSettingsSection: () => null
}))
vi.mock('@/components/settings/CliSection', () => ({ CliSection: () => null }))
vi.mock('@/components/settings/GeneralSupportSection', () => ({
  GeneralSupportSection: () => null
}))
vi.mock('@/components/settings/ReleaseChannelSection', () => ({
  ReleaseChannelSection: () => <div>Release picker open</div>
}))
vi.mock('@/components/settings/DefaultWindowsProjectRuntimeSetting', () => ({
  DefaultWindowsProjectRuntimeSetting: () => null
}))
beforeEach(() => {
  vi.clearAllMocks()
  fake.query = ''
  fake.updates = new Map([
    ['synthetic-host', { environmentId: 'synthetic-host', phase: 'current', name: 'Synthetic' }]
  ])
  Object.assign(window, { api: { updater: { getVersion: fake.getVersion } } })
})
afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
})
it.each([false, true])(
  'retains update sections with Windows runtime support %s',
  async (wslSupportedPlatform) => {
    const props = {
      settings: getDefaultSettings('/synthetic'),
      updateSettings: vi.fn(),
      fontSuggestions: [],
      wslSupportedPlatform
    }
    const view = render(<GeneralPane {...props} />)
    await act(async () => {})
    // The invariant is identity, not a magic number: the matched section keeps the same DOM
    // node across every query edit, so editing the query cannot cost an extra read.
    const mountedHeading = screen.getByText('Updates', { exact: true })
    const versionReadsAfterMount = fake.getVersion.mock.calls.length
    const remoteRefreshesAfterMount = fake.refresh.mock.calls.length
    for (const query of [
      'u',
      'up',
      'upd',
      'upda',
      'updat',
      'update',
      '',
      'v',
      've',
      'ver',
      'vers',
      'versi',
      'versio',
      'version'
    ]) {
      fake.query = query
      await act(async () => view.rerender(<GeneralPane {...props} />))
      expect(screen.getByText('Updates', { exact: true })).toBe(mountedHeading)
    }
    expect(fake.getVersion.mock.calls.length).toBe(versionReadsAfterMount)
    expect(fake.refresh.mock.calls.length).toBe(remoteRefreshesAfterMount)
  }
)

it('keeps showing store-published remote update state without a remount', async () => {
  const props = {
    settings: getDefaultSettings('/synthetic'),
    updateSettings: vi.fn(),
    fontSuggestions: []
  }
  fake.query = 'update'
  const view = render(<GeneralPane {...props} />)
  await act(async () => {})
  const mountedHeading = screen.getByText('Updates', { exact: true })
  expect(screen.getByText('1 paired server · 1 up to date')).toBeTruthy()
  // Remote update entries live in the store, so a retained section stays fresh through the
  // subscription rather than through the remount a query edit used to force.
  fake.updates = new Map([
    ['synthetic-host', { environmentId: 'synthetic-host', phase: 'available', name: 'Synthetic' }]
  ])
  fake.query = 'updat'
  await act(async () => view.rerender(<GeneralPane {...props} />))
  expect(screen.getByText('Updates', { exact: true })).toBe(mountedHeading)
  expect(screen.getByText('1 paired server · 1 ready to update')).toBeTruthy()
  expect(fake.refresh.mock.calls.length).toBe(1)
})
it('keeps explicit remote refresh and true hide/reopen reads', async () => {
  const props = {
    settings: getDefaultSettings('/synthetic'),
    updateSettings: vi.fn(),
    fontSuggestions: []
  }
  const view = render(<GeneralPane {...props} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Check for Server Updates' }))
  expect(fake.refresh).toHaveBeenCalledTimes(2)
  fake.query = 'Tab Order'
  await act(async () => view.rerender(<GeneralPane {...props} />))
  expect(screen.queryByText('Updates', { exact: true })).toBeNull()
  fake.query = 'update'
  await act(async () => view.rerender(<GeneralPane {...props} />))
  expect(fake.getVersion).toHaveBeenCalledTimes(2)
  expect(fake.refresh).toHaveBeenCalledTimes(3)
})

it('preserves an autosave draft until external settings change or the section hides', async () => {
  const settings = { ...getDefaultSettings('/synthetic'), editorAutoSaveDelayMs: 1000 }
  const props = { settings, updateSettings: vi.fn(), fontSuggestions: [] }
  const view = render(<GeneralPane {...props} />)
  await act(async () => {})
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2500' } })
  fake.query = 'Auto Save'
  await act(async () => view.rerender(<GeneralPane {...props} />))
  expect(screen.getByRole('spinbutton').getAttribute('value')).toBe('2500')
  expect(props.updateSettings).not.toHaveBeenCalled()
  const changedProps = { ...props, settings: { ...settings, editorAutoSaveDelayMs: 3000 } }
  await act(async () => view.rerender(<GeneralPane {...changedProps} />))
  expect(screen.getByRole('spinbutton').getAttribute('value')).toBe('3000')
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3500' } })
  fake.query = 'Tab Order'
  await act(async () => view.rerender(<GeneralPane {...changedProps} />))
  expect(screen.queryByRole('spinbutton')).toBeNull()
  fake.query = 'Auto Save'
  await act(async () => view.rerender(<GeneralPane {...changedProps} />))
  expect(screen.getByRole('spinbutton').getAttribute('value')).toBe('3000')
  expect(props.updateSettings).not.toHaveBeenCalled()
})
it('retains the revealed release picker only while Updates remains visible', async () => {
  const props = {
    settings: getDefaultSettings('/synthetic'),
    updateSettings: vi.fn(),
    fontSuggestions: []
  }
  const view = render(<GeneralPane {...props} />)
  await act(async () => {})
  fireEvent.click(screen.getByText('Updates', { exact: true }), { altKey: true })
  expect(screen.getByText('Release picker open')).toBeTruthy()
  fake.query = 'update'
  await act(async () => view.rerender(<GeneralPane {...props} />))
  expect(screen.getByText('Release picker open')).toBeTruthy()
  fake.query = 'Tab Order'
  await act(async () => view.rerender(<GeneralPane {...props} />))
  fake.query = 'update'
  await act(async () => view.rerender(<GeneralPane {...props} />))
  expect(screen.queryByText('Release picker open')).toBeNull()
})
it('does not publish a version result from a genuinely unmounted section', async () => {
  let resolveOld: ((value: string) => void) | undefined
  fake.getVersion.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        resolveOld = resolve
      })
  )
  const props = {
    settings: getDefaultSettings('/synthetic'),
    updateSettings: vi.fn(),
    fontSuggestions: []
  }
  const view = render(<GeneralPane {...props} />)
  await act(async () => {})
  fake.query = 'Tab Order'
  await act(async () => view.rerender(<GeneralPane {...props} />))
  fake.query = 'update'
  await act(async () => view.rerender(<GeneralPane {...props} />))
  expect(screen.getByText('Current version: 1.4.100')).toBeTruthy()
  await act(async () => resolveOld?.('1.0.0'))
  expect(screen.getByText('Current version: 1.4.100')).toBeTruthy()
  expect(screen.queryByText('Current version: 1.0.0')).toBeNull()
})
