// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { usePluginPreviewRequestStore } from '@/store/plugin-preview-request'
import { PluginFileTypeSuggestion } from './PluginFileTypeSuggestion'

const suggestForFileType = vi.fn()
const updateSettings = vi.fn().mockResolvedValue(undefined)
const openSettingsTarget = vi.fn()
const openSettingsPage = vi.fn()

beforeEach(() => {
  suggestForFileType.mockResolvedValue({
    marketplaceSourceId: 'official',
    pluginKey: 'stablyai.orca-typst',
    fileType: 'typ',
    name: 'Typst'
  })
  vi.stubGlobal('api', { plugins: { suggestForFileType } })
  useAppStore.setState({
    settings: { ...getDefaultSettings('/tmp'), pluginSystemEnabled: true },
    updateSettings,
    openSettingsTarget,
    openSettingsPage
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  usePluginPreviewRequestStore.setState({ request: null })
})

it('offers the catalog plugin and opens its preview without installing', async () => {
  render(<PluginFileTypeSuggestion filePath="docs/paper.typ" />)
  expect(await screen.findByText('A plugin can open .typ files: Typst')).toBeTruthy()
  expect(screen.getByRole('status')).toBeTruthy()
  expect(suggestForFileType).toHaveBeenCalledWith('typ', 'open')

  fireEvent.click(screen.getByRole('button', { name: 'View plugin' }))
  expect(usePluginPreviewRequestStore.getState().request).toMatchObject({
    marketplaceSourceId: 'official',
    pluginKey: 'stablyai.orca-typst'
  })
  expect(openSettingsTarget).toHaveBeenCalledWith({ pane: 'plugins', repoId: null })
})

it('remembers "Don\'t suggest" in settings', async () => {
  render(<PluginFileTypeSuggestion filePath="paper.typ" />)
  fireEvent.click(await screen.findByRole('button', { name: "Don't suggest for .typ" }))
  expect(updateSettings).toHaveBeenCalledWith({ pluginDismissedFileTypes: ['typ'] })
})

it('asks nothing when suggestions are off, dismissed, or the file has no extension', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp'),
      pluginSystemEnabled: true,
      pluginDismissedFileTypes: ['typ']
    }
  })
  render(<PluginFileTypeSuggestion filePath="paper.typ" />)
  render(<PluginFileTypeSuggestion filePath="Makefile" />)
  await waitFor(() => expect(suggestForFileType).not.toHaveBeenCalled())
})

it('keeps "Not now" scoped to the file type when the same editor switches files', async () => {
  suggestForFileType.mockImplementation(async (fileType: string) => ({
    marketplaceSourceId: 'official',
    pluginKey: `samples.${fileType}`,
    fileType,
    name: `Plugin ${fileType}`
  }))
  const view = render(<PluginFileTypeSuggestion filePath="a.foo" />)
  fireEvent.click(await view.findByRole('button', { name: 'Not now' }))
  expect(view.queryByRole('status')).toBeNull()

  view.rerender(<PluginFileTypeSuggestion filePath="a.bar" />)
  expect(await view.findByText('A plugin can open .bar files: Plugin bar')).toBeTruthy()

  fireEvent.click(view.getByRole('button', { name: 'Not now' }))
  suggestForFileType.mockClear()
  view.rerender(<PluginFileTypeSuggestion filePath="a.foo" />)
  await waitFor(() => expect(suggestForFileType).not.toHaveBeenCalled())
  expect(view.queryByRole('status')).toBeNull()
})
