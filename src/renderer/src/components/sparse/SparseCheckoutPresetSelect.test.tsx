// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import { setRendererUiLanguage } from '@/i18n/i18n'
import SparseCheckoutPresetSelect from './SparseCheckoutPresetSelect'

const storeMock = vi.hoisted(() => ({
  state: {
    sparsePresetsByRepo: {} as Record<string, SparsePreset[] | undefined>,
    sparsePresetsLoadStatusByRepo: {} as Record<string, 'idle' | 'loading' | 'loaded' | 'error'>,
    sparsePresetsErrorByRepo: {} as Record<string, string | undefined>,
    fetchSparsePresets: vi.fn(),
    saveSparsePreset: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeMock.state) => unknown) => selector(storeMock.state)
}))

describe('SparseCheckoutPresetSelect', () => {
  const existingPreset: SparsePreset = {
    id: 'preset-1',
    repoId: 'repo-1',
    name: 'Existing preset',
    directories: ['src'],
    createdAt: 1,
    updatedAt: 1
  }

  beforeEach(() => {
    storeMock.state.sparsePresetsByRepo = { 'repo-1': [existingPreset] }
    storeMock.state.sparsePresetsLoadStatusByRepo = { 'repo-1': 'loaded' }
    storeMock.state.sparsePresetsErrorByRepo = {}
    storeMock.state.fetchSparsePresets.mockReset()
    storeMock.state.saveSparsePreset.mockReset()
  })

  afterEach(async () => {
    cleanup()
    await setRendererUiLanguage('en')
  })

  it('uses Korean validation messages while drafting a preset from the checkout picker', async () => {
    await setRendererUiLanguage('ko')
    render(
      <SparseCheckoutPresetSelect
        repoId="repo-1"
        presets={[existingPreset]}
        selectedPresetId={null}
        onSelectPreset={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: '새로운 사전 설정' }))

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
