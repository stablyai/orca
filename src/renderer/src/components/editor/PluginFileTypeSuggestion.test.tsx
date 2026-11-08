// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { useAppStore } from '@/store'
import { usePluginPreviewRequestStore } from '@/store/plugins/navigation/plugin-preview-request'
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
