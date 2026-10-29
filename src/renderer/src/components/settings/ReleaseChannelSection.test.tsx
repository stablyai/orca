// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import type { ReleaseBuild } from '../../../../shared/release-channel'
import { ReleaseChannelSection } from './ReleaseChannelSection'

vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: vi.fn(() => 'darwin') }))

const builds: ReleaseBuild[] = [
  {
    tag: 'v1.4.238-adhoc.20261021165056',
    version: '1.4.238-adhoc.20261021165056',
    name: '1.4.238 • plugins-machines-preview • cdcd37a',
    channel: 'adhoc',
    publishedAt: null,
    releaseUrl: 'https://example.com/latest-release',
    installerUrl: 'https://example.com/latest-installer'
  },
  {
    tag: 'v1.4.237-adhoc.20261020165056',
    version: '1.4.237-adhoc.20261020165056',
    name: '1.4.237 • older-branch • ab96d02',
    channel: 'adhoc',
    publishedAt: null,
    releaseUrl: 'https://example.com/older-release',
    installerUrl: 'https://example.com/older-installer'
  }
]
const listBuilds = vi.fn()
const check = vi.fn()
const openUrl = vi.fn()

beforeEach(() => {
  vi.mocked(getShortcutPlatform).mockReturnValue('darwin')
  listBuilds.mockReset().mockResolvedValue({ ok: true, builds })
  check.mockReset().mockResolvedValue(undefined)
  openUrl.mockReset().mockResolvedValue(undefined)
  useAppStore.setState({ updateStatus: { state: 'idle' }, releaseChannelOverride: 'adhoc' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      updater: { getVersion: async () => '1.4.236', listBuilds, check },
      shell: { openUrl },
      ui: { set: async () => {} }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ updateStatus: { state: 'idle' }, releaseChannelOverride: null })
})

async function searchForOlderBuild(): Promise<void> {
  const trigger = screen.getByRole('combobox', { name: 'Build' })
  await waitFor(() => expect(trigger.hasAttribute('disabled')).toBe(false))
  fireEvent.click(trigger)
  fireEvent.change(screen.getByRole('combobox', { name: 'Search builds' }), {
    target: { value: 'older-branch' }
  })
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
  fireEvent.click(screen.getByRole('option'))
  expect(trigger.textContent).toContain('older-branch')
}

it('keeps searching local and switches only to the explicitly selected build on confirmation', async () => {
  render(<ReleaseChannelSection />)
  await searchForOlderBuild()
  expect(listBuilds).toHaveBeenCalledTimes(1)
  expect(check).not.toHaveBeenCalled()
  expect(screen.getByText('1.4.236 → 1.4.237-adhoc.20261020165056')).toBeTruthy()
  const switchButton = screen.getByRole('button', { name: 'Switch to build' })
  fireEvent.click(switchButton)
  expect(check).toHaveBeenCalledWith({ channel: 'adhoc', targetTag: builds[1].tag })

  act(() => useAppStore.setState({ updateStatus: { state: 'checking' } }))
  expect(switchButton.hasAttribute('disabled')).toBe(true)
})

it('keeps the Windows manual-install path tied to the selected search result', async () => {
  vi.mocked(getShortcutPlatform).mockReturnValue('win32')
  render(<ReleaseChannelSection />)
  await searchForOlderBuild()
  fireEvent.click(screen.getByRole('button', { name: 'Download installer' }))
  expect(openUrl).toHaveBeenCalledWith(builds[1].installerUrl)
  expect(check).not.toHaveBeenCalled()
})

it('resets selection on refresh and keeps load failures recoverable', async () => {
  render(<ReleaseChannelSection />)
  await searchForOlderBuild()
  listBuilds.mockResolvedValueOnce({ ok: false, message: 'Build feed unavailable.' })
  fireEvent.click(screen.getByRole('button', { name: 'Refresh build list' }))
  await screen.findByText('Build feed unavailable.')
  expect(screen.getByRole('combobox', { name: 'Build' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('button', { name: 'Switch to build' }).hasAttribute('disabled')).toBe(
    true
  )

  fireEvent.click(screen.getByRole('button', { name: 'Refresh build list' }))
  await waitFor(() =>
    expect(screen.getByRole('combobox', { name: 'Build' }).textContent).toContain(
      'plugins-machines-preview'
    )
  )
  expect(screen.queryByText('Build feed unavailable.')).toBeNull()
  expect(listBuilds).toHaveBeenLastCalledWith('adhoc', { force: true })
})

it('discards a previous channel search and offers only the newly loaded channel', async () => {
  render(<ReleaseChannelSection />)
  await searchForOlderBuild()
  fireEvent.click(screen.getByRole('combobox', { name: 'Build' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Search builds' }), {
    target: { value: 'older-branch' }
  })
  listBuilds.mockResolvedValueOnce({
    ok: true,
    builds: [{ ...builds[0], channel: 'stable', tag: 'v1.4.238', version: '1.4.238', name: null }]
  })
  fireEvent.click(screen.getByRole('radio', { name: /^Stable$/ }))
  const trigger = screen.getByRole('combobox', { name: 'Build' })
  await waitFor(() => expect(trigger.textContent).toBe('1.4.238'))
  fireEvent.click(trigger)
  expect(screen.getByRole('combobox', { name: 'Search builds' }).getAttribute('value')).toBe('')
  expect(screen.getAllByRole('option')).toHaveLength(1)
  expect(screen.getByRole('option').textContent).toBe('1.4.238')
})
