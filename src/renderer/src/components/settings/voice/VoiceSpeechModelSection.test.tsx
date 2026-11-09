// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechModelManifest, SpeechModelState } from '../../../../../shared/speech-types'
import { getDefaultVoiceSettings } from '../../../../../shared/constants'

const toastErrorMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock
  }
}))

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values ? fallback.replace('{{value0}}', values.value0) : fallback
}))

import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'

const localModel: SpeechModelManifest = {
  id: 'model-a',
  label: 'Local Model',
  provider: 'local',
  language: 'en',
  languages: ['en'],
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
        onUpdateVoiceSettings={vi.fn()}
        ratingLanguage="en"
        onOpenCloudSetup={vi.fn()}
        onRefreshModelStates={args.refreshModelStates ?? vi.fn()}
        cloudSettings={null}
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
})
