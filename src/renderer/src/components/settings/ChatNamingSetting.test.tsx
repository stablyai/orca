// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SourceControlAiSettingsPatch } from '../../../../shared/source-control-ai-types'
import { normalizeSourceControlAiSettings } from '../../../../shared/source-control-ai'
import { ChatNamingSetting } from './ChatNamingSetting'
import { toast } from 'sonner'
import { startTransition, StrictMode, Suspense } from 'react'

const state = vi.hoisted(() => ({ settingsSearchQuery: '' }))
vi.mock('../../store', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state)
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
beforeEach(() => {
  state.settingsSearchQuery = ''
  vi.clearAllMocks()
})

function renderSetting(overrides: Partial<GlobalSettings> = {}) {
  const settings = { ...getDefaultSettings('/tmp'), ...overrides }
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
  return { ...view, element, settings, updateSettings, writeSourceControlAiSettings, onDirtyChange }
}

function changeTemplate(value: string): void {
  const input = screen.getByText('Command template').nextElementSibling
  if (!(input instanceof HTMLTextAreaElement)) {
    throw new Error('Command template textarea is missing')
  }
  fireEvent.change(input, { target: { value } })
}

function changeAgentArgs(value: string): void {
  const input = screen.getByText('CLI arguments').nextElementSibling
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('CLI arguments input is missing')
  }
  fireEvent.change(input, { target: { value } })
}

describe('Chat names setting', () => {
  it('defaults to on and writes the off preference', () => {
    const { updateSettings } = renderSetting()
    const toggle = screen.getByRole('switch', { name: 'Name chats automatically' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({ nativeChatAutoName: false })
  })

  it('saves CLI arguments and a template through the shared writer', async () => {
    const { settings, writeSourceControlAiSettings, onDirtyChange } = renderSetting({
      sourceControlAi: normalizeSourceControlAiSettings({
        ...normalizeSourceControlAiSettings(undefined),
        enabled: false,
        actions: { commitMessage: { commandInputTemplate: 'Keep this Git recipe' } }
      })
    })
    changeTemplate('Name: {firstPrompt}')
    changeAgentArgs('--model fast')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(writeSourceControlAiSettings).toHaveBeenCalledTimes(1))
    expect(settings.sourceControlAi?.actions?.conversationName).toEqual({
      commandInputTemplate: 'Name: {firstPrompt}',
      agentArgs: '--model fast'
    })
    expect(settings.sourceControlAi?.enabled).toBe(false)
    expect(settings.sourceControlAi?.actions?.commitMessage?.commandInputTemplate).toBe(
      'Keep this Git recipe'
    )
    await waitFor(() => expect(onDirtyChange).toHaveBeenLastCalledWith(false))
  })

  it('persists the selected agent without replacing a Git recipe', async () => {
    const { settings } = renderSetting({
      sourceControlAi: normalizeSourceControlAiSettings({
        ...normalizeSourceControlAiSettings(undefined),
        actions: { commitMessage: { commandInputTemplate: 'Keep this' } }
      })
    })
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(screen.getByRole('option', { name: 'Custom command' }))
    await waitFor(() => {
      expect(settings.sourceControlAi?.actions?.conversationName?.agentId).toBe('custom')
    })
    expect(settings.sourceControlAi?.actions?.commitMessage?.commandInputTemplate).toBe('Keep this')
  })

  it('keeps the saved recipe hidden when chat naming is off', () => {
    renderSetting({ nativeChatAutoName: false })
    expect(
      screen.getByRole('switch', { name: 'Name chats automatically' }).getAttribute('aria-checked')
    ).toBe('false')
    expect(screen.queryByText('Command template')).toBeNull()
  })

  it('keeps naming independent of Git AI enablement and exposes only its variables', () => {
    renderSetting({
      sourceControlAi: normalizeSourceControlAiSettings({
        ...normalizeSourceControlAiSettings(undefined),
        enabled: false
      })
    })
    expect(screen.getAllByRole('combobox')).toHaveLength(1)
    expect(screen.getByText('Command template')).toBeTruthy()
    expect(screen.getByRole('button', { name: '{basePrompt}' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '{firstPrompt}' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '{branch}' })).toBeNull()
  })

  it('appends variables and discards only the unsaved recipe', () => {
    const { settings, writeSourceControlAiSettings, onDirtyChange } = renderSetting()
    const persistedRecipe = settings.sourceControlAi?.actions?.conversationName
    changeTemplate('Name:')
    fireEvent.click(screen.getByRole('button', { name: '{firstPrompt}' }))
    expect(screen.getByDisplayValue('Name: {firstPrompt}')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByDisplayValue('{basePrompt}')).toBeTruthy()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    expect(writeSourceControlAiSettings).not.toHaveBeenCalled()
    expect(settings.sourceControlAi?.actions?.conversationName).toEqual(persistedRecipe)
  })

  it('keeps a dirty recipe accessible when naming is switched off or search changes', () => {
    const { settings, element, rerender, onDirtyChange } = renderSetting()
    changeTemplate('Keep my edits')
    settings.nativeChatAutoName = false
    state.settingsSearchQuery = 'unmatched search'
    rerender(element())
    expect(screen.getByDisplayValue('Keep my edits')).toBeTruthy()
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.queryByText('Command template')).toBeNull()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('keeps unsaved edits after a failed recipe write', async () => {
    const { writeSourceControlAiSettings, onDirtyChange } = renderSetting()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    writeSourceControlAiSettings.mockRejectedValueOnce(new Error('write failed'))
    changeTemplate('Retry this recipe')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Could not save chat name settings.')
    )
    expect(screen.getByDisplayValue('Retry this recipe')).toBeTruthy()
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(false)
  })

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
    changeTemplate('New draft')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    onDirtyChange.mockClear()
    await act(async () => finishWrite())
    expect(onDirtyChange).not.toHaveBeenCalled()
    expect(screen.getByDisplayValue('New draft')).toBeTruthy()
  })

  it('notifies the latest committed dirty callback after a pending save and on unmount', async () => {
    const { settings, updateSettings, writeSourceControlAiSettings, rerender, unmount } =
      renderSetting()
    let finishWrite = (): void => {}
    writeSourceControlAiSettings.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = resolve
        })
    )
    changeTemplate('Pending save')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const onDirtyChange = vi.fn()
    rerender(
      <ChatNamingSetting
        settings={settings}
        updateSettings={updateSettings}
        writeSourceControlAiSettings={writeSourceControlAiSettings}
        onDirtyChange={onDirtyChange}
      />
    )
    await act(async () => finishWrite())
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
    changeTemplate('Unsaved after save')
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
    unmount()
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
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
