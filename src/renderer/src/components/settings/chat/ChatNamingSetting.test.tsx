// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { SourceControlAiSettingsPatch } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import { normalizeSourceControlAiSettings } from '../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { ChatNamingSetting } from './ChatNamingSetting'
import { startTransition, StrictMode, Suspense } from 'react'

import { useAppStore } from '@/store/index'
import '../__fixtures__/settings-persistence-test-fixture'
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
beforeEach(() => {
  useAppStore.setState({ settingsSearchQuery: '' })
  vi.clearAllMocks()
})

function renderSetting(overrides: Partial<GlobalSettings> = {}, expand = true) {
  const settings = { ...getDefaultSettings('/tmp'), ...overrides }
  useAppStore.setState({ settings })
  const updateSettings = vi.fn()
  const onDirtyChange = vi.fn()
  const writeSourceControlAiSettings = vi.fn(async (patch: SourceControlAiSettingsPatch) => {
    const current = normalizeSourceControlAiSettings(
      settings.sourceControlAi,
      settings.commitMessageAi
    )
    const resolved = typeof patch === 'function' ? patch(current) : patch
    settings.sourceControlAi = { ...current, ...resolved }
  })
  const element = () => (
    <ChatNamingSetting
      settings={settings}
      updateSettings={updateSettings}
      writeSourceControlAiSettings={writeSourceControlAiSettings}
      onDirtyChange={onDirtyChange}
    />
  )
  const view = render(element())
  if (expand && screen.queryByRole('button', { name: 'Advanced' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
  }
  return { ...view, element, settings, updateSettings, writeSourceControlAiSettings, onDirtyChange }
}

function changeTemplate(value: string): void {
  const input = screen.getByText('Command template').nextElementSibling
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error('Command template textarea is missing')
  }
  fireEvent.change(input, { target: { value } })
}

describe('Chat names setting', () => {
  it('preserves edits made while a recipe save is pending', async () => {
    const { settings, element, rerender, writeSourceControlAiSettings, onDirtyChange } =
      renderSetting()
    let finishWrite: (() => void) | undefined
    const pendingWrite = new Promise<void>((resolve) => {
      finishWrite = resolve
    })
    writeSourceControlAiSettings.mockImplementationOnce(async (patch) => {
      await pendingWrite
      const current = normalizeSourceControlAiSettings(
        settings.sourceControlAi,
        settings.commitMessageAi
      )
      const resolved = typeof patch === 'function' ? patch(current) : patch
      settings.sourceControlAi = { ...current, ...resolved }
    })
    changeTemplate('First save')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    changeTemplate('Later edits')
    finishWrite?.()
    await waitFor(() =>
      expect(settings.sourceControlAi?.actions?.conversationName?.commandInputTemplate).toBe(
        'First save'
      )
    )
    rerender(element())
    expect(screen.getByDisplayValue('Later edits')).toBeTruthy()
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
  })

  it('does not clear a new draft guard when an unmounted recipe finishes saving', async () => {
    const { unmount, element, writeSourceControlAiSettings, onDirtyChange } = renderSetting()
    let finishWrite = (): void => {}
    writeSourceControlAiSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )
    changeTemplate('Saved after leaving')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    unmount()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    render(<StrictMode>{element()}</StrictMode>)
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    changeTemplate('New draft')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    onDirtyChange.mockClear()
    await act(async () => finishWrite())
    expect(onDirtyChange).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('New draft')).toBeTruthy()
  })

  it('keeps a pending save owned by its committed callback during an unfinished render', async () => {
    const settings = getDefaultSettings('/tmp')
    const committedDirty = vi.fn()
    const speculativeDirty = vi.fn()
    const suspendAttempt = vi.fn()
    const suspended = new Promise<void>(() => {})
    let finishWrite = (): void => {}
    const writeSourceControlAiSettings = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )
    function RenderGate({ blocked }: { blocked: boolean }) {
      if (blocked) {
        suspendAttempt()
        throw suspended
      }
      return null
    }
    const element = (blocked: boolean) => (
      <Suspense fallback={<span>Settings loading</span>}>
        <ChatNamingSetting
          settings={settings}
          updateSettings={vi.fn()}
          writeSourceControlAiSettings={writeSourceControlAiSettings}
          onDirtyChange={blocked ? speculativeDirty : committedDirty}
        />
        <RenderGate blocked={blocked} />
      </Suspense>
    )
    const { rerender, unmount } = render(element(false))
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    changeTemplate('Committed save')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await act(async () => {
      startTransition(() => rerender(element(true)))
    })
    expect(suspendAttempt).toHaveBeenCalled()
    expect(screen.queryByText('Settings loading')).toBeNull()
    committedDirty.mockClear()
    await act(async () => finishWrite())
    expect(committedDirty).toHaveBeenLastCalledWith(false)
    expect(speculativeDirty).not.toHaveBeenCalled()
    unmount()
    expect(committedDirty).toHaveBeenLastCalledWith(false)
    expect(speculativeDirty).not.toHaveBeenCalled()
  })
})
