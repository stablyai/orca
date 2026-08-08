// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { SpeechModelManifest, VoiceSettings } from '../../../../shared/speech-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { VoiceTranscriptionLanguageSetting } from './VoiceTranscriptionLanguageSetting'

const CLOUD_MODEL: SpeechModelManifest = {
  id: 'openai-gpt-4o-mini-transcribe',
  label: 'GPT-4o mini Transcribe',
  description: 'Cloud transcription.',
  type: 'openai',
  provider: 'openai',
  language: 'multilingual',
  sampleRate: 16000,
  streaming: false
}

const LOCAL_MODEL: SpeechModelManifest = {
  ...CLOUD_MODEL,
  id: 'local-model',
  label: 'Local model',
  type: 'senseVoice',
  provider: 'local'
}

function render(args: {
  voiceSettings?: Partial<VoiceSettings>
  selectedModel: SpeechModelManifest | undefined
}): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(
      <VoiceTranscriptionLanguageSetting
        voiceSettings={{ ...getDefaultVoiceSettings(), enabled: true, ...args.voiceSettings }}
        selectedModel={args.selectedModel}
        onUpdateVoiceSettings={() => {}}
      />
    )
  })
  return { container, root }
}

function getTrigger(container: HTMLElement): HTMLButtonElement {
  const trigger = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Transcription Language"]'
  )
  if (!trigger) {
    throw new Error('Transcription language trigger was not rendered')
  }
  return trigger
}

describe('VoiceTranscriptionLanguageSetting', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('is enabled for a selected cloud model', () => {
    const { container, root } = render({ selectedModel: CLOUD_MODEL })
    expect(getTrigger(container).disabled).toBe(false)
    act(() => root.unmount())
  })

  it('is disabled and explains why for a selected local model', () => {
    const { container, root } = render({ selectedModel: LOCAL_MODEL })
    expect(getTrigger(container).disabled).toBe(true)
    expect(container.textContent).toContain('cloud (OpenAI) speech models only')
    act(() => root.unmount())
  })

  it('is disabled when voice dictation is off', () => {
    const { container, root } = render({
      voiceSettings: { enabled: false },
      selectedModel: CLOUD_MODEL
    })
    expect(getTrigger(container).disabled).toBe(true)
    act(() => root.unmount())
  })
})
