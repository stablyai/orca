// @vitest-environment happy-dom

import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpeechModelManifest } from '../../../../shared/speech-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en',
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(values?.[name] ?? ''))
}))

vi.mock('../ui/select', () => ({
  Select: ({ children, disabled }: { children: ReactNode; disabled?: boolean }) => (
    <div data-testid="select" data-disabled={disabled ? 'true' : 'false'}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({
    children,
    value,
    disabled
  }: {
    children: ReactNode
    value: string
    disabled?: boolean
  }) => (
    <div data-testid={`item-${value}`} data-disabled={disabled ? 'true' : 'false'}>
      {children}
    </div>
  )
}))

import { VoiceTranscriptionLanguageSetting } from './VoiceTranscriptionLanguageSetting'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function model(transcriptionLanguages: SpeechModelManifest['transcriptionLanguages']) {
  return {
    id: 'm',
    label: 'Voxtral Mini',
    description: '',
    type: 'cloud',
    provider: 'mistral',
    language: 'multilingual',
    sampleRate: 16000,
    streaming: false,
    transcriptionLanguages
  } satisfies SpeechModelManifest
}

function render(selectedModel: SpeechModelManifest | undefined, language = 'uk'): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() =>
    root?.render(
      <VoiceTranscriptionLanguageSetting
        voiceSettings={{
          ...getDefaultVoiceSettings(),
          enabled: true,
          transcriptionLanguage: language
        }}
        selectedModel={selectedModel}
        onUpdateVoiceSettings={vi.fn()}
      />
    )
  )
  return container
}

describe('VoiceTranscriptionLanguageSetting', () => {
  it('locks the select for a model that detects the language itself', () => {
    const view = render(model(undefined))
    expect(view.querySelector('[data-testid="select"]')?.getAttribute('data-disabled')).toBe('true')
    expect(view.textContent).toContain('Voxtral Mini detects the language itself.')
  })

  it('disables languages the model cannot honour and explains the fallback', () => {
    const view = render(model(['en', 'de']))
    expect(view.querySelector('[data-testid="item-uk"]')?.getAttribute('data-disabled')).toBe(
      'true'
    )
    expect(view.querySelector('[data-testid="item-de"]')?.getAttribute('data-disabled')).toBe(
      'false'
    )
    expect(view.querySelector('[data-testid="item-auto"]')?.getAttribute('data-disabled')).toBe(
      'false'
    )
    expect(view.textContent).toContain("doesn't support")
    expect(view.textContent).toContain('so it will auto-detect')
  })

  it('offers every language before a model is chosen', () => {
    const view = render(undefined)
    expect(view.querySelector('[data-testid="item-uk"]')?.getAttribute('data-disabled')).toBe(
      'false'
    )
  })
})
