// @vitest-environment happy-dom

import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechModelManifest, SpeechModelState } from '../../../../shared/speech-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'

const toastErrorMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values ? fallback.replace('{{value0}}', values.value0) : fallback
}))

vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    className
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: () => void
    className?: string
  }) => (
    <div
      className={className}
      aria-disabled={disabled}
      role="option"
      onClick={() => {
        if (!disabled) {
          onSelect?.()
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
  catalog?: SpeechModelManifest[]
  modelStates?: SpeechModelState[]
  refreshModelStates?: () => void
}): { container: HTMLDivElement; root: Root } {
  Object.assign(window, {
    api: {
      speech: {
        deleteModel: vi.fn(args.deleteModel),
        downloadModel: vi.fn()
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
        onUpdateVoiceSettings={vi.fn()}
        onOpenOpenAiDialog={vi.fn()}
        onRefreshModelStates={args.refreshModelStates ?? vi.fn()}
      />
    )
  })

  return { container, root }
}

describe('VoiceSpeechModelSection', () => {
  beforeEach(() => {
    toastErrorMock.mockReset()
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
})
