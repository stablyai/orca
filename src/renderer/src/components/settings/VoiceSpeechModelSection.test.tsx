// @vitest-environment happy-dom

import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  SpeechModelManifest,
  SpeechModelState,
  VoiceSettings
} from '../../../../shared/speech-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'

const toastErrorMock = vi.hoisted(() => vi.fn())
const menuDismissMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values ? fallback.replace(/{{(\w+)}}/g, (_match, key: string) => values[key] ?? '') : fallback
}))

vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuLabel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
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
  updateVoiceSettings?: (updates: Partial<VoiceSettings>) => void
  openCloudDialog?: (provider: 'openai' | 'openrouter', modelId: string) => void
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
        onOpenCloudDialog={args.openCloudDialog ?? vi.fn()}
        onRefreshModelStates={args.refreshModelStates ?? vi.fn()}
      />
    )
  })

  return { container, root }
}

const openRouterModel: SpeechModelManifest = {
  id: 'openrouter-mai-transcribe-2',
  label: 'MAI-Transcribe 2',
  description: 'Microsoft multilingual transcription',
  provider: 'openrouter',
  language: 'multilingual',
  type: 'openrouter',
  streaming: false,
  sampleRate: 16000
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

  it('groups an unordered catalog into Local, OpenAI and OpenRouter', () => {
    const openAiModel: SpeechModelManifest = {
      ...openRouterModel,
      id: 'openai',
      provider: 'openai'
    }
    const { container, root } = renderSection({
      deleteModel: async () => {},
      catalog: [openRouterModel, localModel, openAiModel, secondLocalModel]
    })
    const menu = container.querySelector('[role="option"]')?.parentElement
    expect(Array.from(menu?.children ?? [], (child) => child.textContent)).toEqual([
      'LOCAL',
      expect.stringContaining('Local Model'),
      expect.stringContaining('Second Local Model'),
      'OPENAI',
      expect.stringContaining('OpenAI API'),
      'OPENROUTER',
      expect.stringContaining('OpenRouter API')
    ])
    root.unmount()
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
  it.each(['openai', 'openrouter'] as const)(
    'selects ready %s models with provider metadata and no download or delete action',
    async (provider) => {
      const model: SpeechModelManifest = { ...openRouterModel, provider }
      const updateVoiceSettings = vi.fn()
      const { container, root } = renderSection({
        deleteModel: async () => {},
        catalog: [model],
        modelStates: [{ id: model.id, status: 'ready' }],
        updateVoiceSettings
      })
      const option = container.querySelector<HTMLElement>('[role="option"]')
      expect(option?.textContent).toContain(provider === 'openai' ? 'OpenAI API' : 'OpenRouter API')
      expect(option?.querySelector('button')).toBeNull()
      await act(async () => option?.click())
      expect(updateVoiceSettings).toHaveBeenCalledWith({ sttModel: model.id })
      expect(window.api.speech.downloadModel).not.toHaveBeenCalled()
      root.unmount()
    }
  )

  it('opens OpenRouter key setup for an unavailable MAI model', async () => {
    const openCloudDialog = vi.fn()
    const { container, root } = renderSection({
      deleteModel: async () => {},
      catalog: [openRouterModel],
      modelStates: [{ id: openRouterModel.id, status: 'not-downloaded' }],
      openCloudDialog
    })
    await act(async () => container.querySelector<HTMLElement>('[role="option"]')?.click())
    expect(openCloudDialog).toHaveBeenCalledWith('openrouter', openRouterModel.id)
    expect(window.api.speech.downloadModel).not.toHaveBeenCalled()
    root.unmount()
  })
})
