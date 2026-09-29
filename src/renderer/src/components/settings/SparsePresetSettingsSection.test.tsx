// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { fireEvent, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { SparsePresetSettingsSection } from './SparsePresetSettingsSection'

const storeMock = vi.hoisted(() => ({
  state: {
    sparsePresetsByRepo: {} as Record<string, SparsePreset[]>,
    sparsePresetsLoadStatusByRepo: {} as Record<string, 'idle' | 'loading' | 'loaded' | 'error'>,
    sparsePresetsErrorByRepo: {} as Record<string, string | undefined>,
    fetchSparsePresets: vi.fn(),
    saveSparsePreset: vi.fn(),
    removeSparsePreset: vi.fn()
  }
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeMock.state) => unknown) => selector(storeMock.state)
}))

describe('SparsePresetSettingsSection', () => {
  const existingPreset: SparsePreset = {
    id: 'preset-1',
    repoId: 'repo-1',
    name: 'Existing preset',
    directories: ['src'],
    createdAt: 1,
    updatedAt: 1
  }

  beforeEach(() => {
    storeMock.state.sparsePresetsByRepo = {}
    storeMock.state.sparsePresetsLoadStatusByRepo = {}
    storeMock.state.sparsePresetsErrorByRepo = {}
    storeMock.state.fetchSparsePresets.mockReset()
    storeMock.state.saveSparsePreset.mockReset()
    storeMock.state.removeSparsePreset.mockReset()
  })

  afterEach(async () => {
    cleanup()
    await setRendererUiLanguage('en')
  })

  it('surfaces sparse preset load failures inline instead of showing an endless loader', () => {
    storeMock.state.sparsePresetsLoadStatusByRepo = { 'repo-1': 'error' }
    storeMock.state.sparsePresetsErrorByRepo = { 'repo-1': 'disk failed' }

    const { container } = render(<SparsePresetSettingsSection repoId="repo-1" />)

    expect(container.querySelector('[role="alert"]')).toHaveTextContent('disk failed')
    expect(screen.getByText('Sparse presets could not be loaded.')).toBeInTheDocument()
  })

  it('keeps all desktop name validation messages in English', () => {
    storeMock.state.sparsePresetsByRepo = { 'repo-1': [existingPreset] }
    storeMock.state.sparsePresetsLoadStatusByRepo = { 'repo-1': 'loaded' }

    render(<SparsePresetSettingsSection repoId="repo-1" />)
    fireEvent.click(screen.getByRole('button', { name: 'New Preset' }))

    const nameInput = screen.getByLabelText('Name')
    expect(screen.getByText('Name is required.')).toBeInTheDocument()

    fireEvent.change(nameInput, { target: { value: 'a'.repeat(81) } })
    expect(screen.getByText('Name must be 80 characters or fewer.')).toBeInTheDocument()

    fireEvent.change(nameInput, { target: { value: existingPreset.name } })
    expect(screen.getByText('"Existing preset" already exists.')).toBeInTheDocument()
  })

  it('uses Korean name validation messages without attaching a particle to the preset name', async () => {
    await setRendererUiLanguage('ko')
    storeMock.state.sparsePresetsByRepo = { 'repo-1': [existingPreset] }
    storeMock.state.sparsePresetsLoadStatusByRepo = { 'repo-1': 'loaded' }

    render(<SparsePresetSettingsSection repoId="repo-1" />)
    fireEvent.click(screen.getByRole('button', { name: '새로운 사전 설정' }))

    const nameInput = screen.getByLabelText('이름')
    expect(screen.getByText('이름을 입력해 주세요.')).toBeInTheDocument()

    fireEvent.change(nameInput, { target: { value: 'a'.repeat(81) } })
    expect(screen.getByText('이름은 80자 이하여야 합니다.')).toBeInTheDocument()

    fireEvent.change(nameInput, { target: { value: existingPreset.name } })
    expect(
      screen.getByText('"Existing preset" 이름의 사전 설정이 이미 있습니다.')
    ).toBeInTheDocument()
  })
})
