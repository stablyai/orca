// @vitest-environment happy-dom

import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechModelManifest, SpeechModelState } from '../../../../shared/speech-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'

const toastErrorMock = vi.hoisted(() => vi.fn())
const menuDismissMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => (
    <div data-testid="group-label">{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    className
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: (event: Event) => void
    className?: string
  }) => (
    <div
      className={className}
      aria-disabled={disabled}
      role="option"
      onClick={() => {
        if (!disabled) {
          const selectEvent = new Event('select', { cancelable: true })
          onSelect?.(selectEvent)
          if (!selectEvent.defaultPrevented) {
            menuDismissMock()
          }
        }
      }}
    >
      {children}
    </div>
  )
}))

import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'

const localModel: SpeechModelManifest = {
  id: 'model-a',
  label: 'Local Model',
  description: 'Runs offline',
  provider: 'local',
  language: 'en',
  type: 'transducer',
  streaming: true,
  sampleRate: 16000,
  sizeBytes: 123_000_000,
  files: ['encoder.onnx']
}

const sonioxModel: SpeechModelManifest = {
  id: 'soniox-stt-rt',
  label: 'Soniox Real-time',
  description: 'Live captions',
  provider: 'soniox',
  language: 'multilingual',
  type: 'cloud',
  streaming: false,
  realtime: true,
  sampleRate: 16000
}

const openAiModel: SpeechModelManifest = {
  ...sonioxModel,
  id: 'openai-gpt-4o-transcribe',
  label: 'GPT-4o Transcribe',
  provider: 'openai',
  realtime: false
}

const secondLocalModel: SpeechModelManifest = {
  ...localModel,
  id: 'model-b',
  label: 'Second Local Model'
}

function renderSection(args: {
  deleteModel: (modelId: string) => Promise<void>
  downloadModel?: (modelId: string) => Promise<void>
  catalog?: SpeechModelManifest[]
  modelStates?: SpeechModelState[]
  refreshModelStates?: () => void
  openCloudKeyDialog?: (providerId: string, modelId: string) => void
  updateVoiceSettings?: (updates: Record<string, unknown>) => void
}): { container: HTMLDivElement; root: Root } {
  Object.assign(window, {
    api: {
      speech: {
        deleteModel: vi.fn(args.deleteModel),
        downloadModel: vi.fn(args.downloadModel ?? (() => Promise.resolve()))
      }
    }
  })

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const voiceSettings = { ...getDefaultVoiceSettings(), enabled: true, sttModel: localModel.id }
  const catalog = args.catalog ?? [localModel]
  const modelStates = args.modelStates ?? [{ id: localModel.id, status: 'ready' }]
  act(() => {
    root.render(
      <VoiceSpeechModelSection
        voiceSettings={voiceSettings}
        catalog={catalog}
        modelStates={modelStates}
        onUpdateVoiceSettings={args.updateVoiceSettings ?? vi.fn()}
        onOpenCloudKeyDialog={args.openCloudKeyDialog ?? vi.fn()}
        onRefreshModelStates={args.refreshModelStates ?? vi.fn()}
      />
    )
  })

  return { container, root }
}

describe('VoiceSpeechModelSection', () => {
  beforeEach(() => {
    toastErrorMock.mockReset()
    menuDismissMock.mockReset()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('shows delete for the selected ready local row and refreshes after success', async () => {
    let resolveDelete: () => void = () => {}
    const refreshModelStates = vi.fn()
    const { container, root } = renderSection({
      refreshModelStates,
      deleteModel: () =>
        new Promise<void>((resolve) => {
          resolveDelete = resolve
        })
    })
    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Local Model"]'
    )

    expect(deleteButton).not.toBeNull()
    await act(async () => {
      deleteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(window.api.speech.deleteModel).toHaveBeenCalledWith(localModel.id)
    expect(deleteButton!.disabled).toBe(true)

    await act(async () => {
      deleteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      resolveDelete()
      await Promise.resolve()
    })

    expect(window.api.speech.deleteModel).toHaveBeenCalledTimes(1)
    expect(refreshModelStates).toHaveBeenCalledTimes(1)
    root.unmount()
  })

  it('keeps another row delete disabled until its own request finishes', async () => {
    const deleteResolvers = new Map<string, () => void>()
    const refreshModelStates = vi.fn()
    const { container, root } = renderSection({
      refreshModelStates,
      catalog: [localModel, secondLocalModel],
      modelStates: [
        { id: localModel.id, status: 'ready' },
        { id: secondLocalModel.id, status: 'ready' }
      ],
      deleteModel: (modelId) =>
        new Promise<void>((resolve) => {
          deleteResolvers.set(modelId, resolve)
        })
    })
    const firstDeleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Local Model"]'
    )
    const secondDeleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Second Local Model"]'
    )

    await act(async () => {
      firstDeleteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      secondDeleteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(firstDeleteButton!.disabled).toBe(true)
    expect(secondDeleteButton!.disabled).toBe(true)

    await act(async () => {
      deleteResolvers.get(localModel.id)!()
      await Promise.resolve()
    })

    expect(firstDeleteButton!.disabled).toBe(false)
    expect(secondDeleteButton!.disabled).toBe(true)

    await act(async () => {
      deleteResolvers.get(secondLocalModel.id)!()
      await Promise.resolve()
    })

    expect(refreshModelStates).toHaveBeenCalledTimes(2)
    root.unmount()
  })

  it('shows the existing error toast when selected-row deletion fails', async () => {
    const refreshModelStates = vi.fn()
    const { container, root } = renderSection({
      refreshModelStates,
      deleteModel: () => Promise.reject(new Error('in use'))
    })
    const deleteButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Delete Local Model"]'
    )

    await act(async () => {
      deleteButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(toastErrorMock).toHaveBeenCalledWith('Failed to delete model.')
    expect(refreshModelStates).not.toHaveBeenCalled()
    root.unmount()
  })

  it('keeps the model menu open when starting a local model download', async () => {
    const { container, root } = renderSection({
      deleteModel: () => Promise.resolve(),
      modelStates: [{ id: localModel.id, status: 'not-downloaded' }]
    })
    const modelOption = container.querySelector<HTMLElement>('[role="option"]')

    await act(async () => {
      modelOption!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(window.api.speech.downloadModel).toHaveBeenCalledWith(localModel.id)
    expect(menuDismissMock).not.toHaveBeenCalled()
    root.unmount()
  })

  it('groups models by provider with on-device first and marks realtime models live', () => {
    const { container, root } = renderSection({
      deleteModel: () => Promise.resolve(),
      catalog: [openAiModel, sonioxModel, localModel],
      modelStates: [{ id: localModel.id, status: 'ready' }]
    })

    const groupLabels = [...container.querySelectorAll('[data-testid="group-label"]')]
    expect(groupLabels.map((node) => node.querySelector('span')?.textContent)).toEqual([
      'On-device',
      'Soniox',
      'OpenAI'
    ])
    // One key per provider: the prompt sits on the group, never on each model row.
    expect(groupLabels[0].textContent).not.toContain('API key needed')
    expect(groupLabels[1].textContent).toContain('API key needed')
    const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options[1].textContent).toContain('live')
    expect(options[1].textContent).not.toContain('Add key')
    expect(options[2].textContent).not.toContain('live')
    root.unmount()
  })

  it('opens the key dialog for the model provider when its key is missing', async () => {
    const openCloudKeyDialog = vi.fn()
    const updateVoiceSettings = vi.fn()
    const { container, root } = renderSection({
      deleteModel: () => Promise.resolve(),
      catalog: [sonioxModel],
      modelStates: [{ id: sonioxModel.id, status: 'not-downloaded' }],
      openCloudKeyDialog,
      updateVoiceSettings
    })

    await act(async () => {
      container.querySelector<HTMLElement>('[role="option"]')!.click()
    })

    expect(openCloudKeyDialog).toHaveBeenCalledWith('soniox', sonioxModel.id)
    expect(updateVoiceSettings).not.toHaveBeenCalled()
    expect(window.api.speech.downloadModel).not.toHaveBeenCalled()
    root.unmount()
  })

  it('selects a cloud model directly once its provider key is configured', async () => {
    const openCloudKeyDialog = vi.fn()
    const updateVoiceSettings = vi.fn()
    const { container, root } = renderSection({
      deleteModel: () => Promise.resolve(),
      catalog: [sonioxModel],
      modelStates: [{ id: sonioxModel.id, status: 'ready' }],
      openCloudKeyDialog,
      updateVoiceSettings
    })

    await act(async () => {
      container.querySelector<HTMLElement>('[role="option"]')!.click()
    })

    expect(updateVoiceSettings).toHaveBeenCalledWith({ sttModel: sonioxModel.id })
    expect(openCloudKeyDialog).not.toHaveBeenCalled()
    root.unmount()
  })
})
