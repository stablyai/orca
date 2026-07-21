// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { DictationOutputCapabilities } from '../../../../shared/dictation-output-settings'
import { getVoiceAudioOutputSearchEntry } from './voice-pane-search'
import { VoiceAudioOutputSection } from './VoiceAudioOutputSection'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    values ? fallback.replace('{{value0}}', String(values.value0)) : fallback
}))

function renderSection(
  args: {
    capabilities?: DictationOutputCapabilities
    updates?: (updates: Record<string, unknown>) => void
  } = {}
): { container: HTMLDivElement; root: Root; updates: ReturnlessUpdate[] } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const updates: ReturnlessUpdate[] = []
  const update = vi.fn((next: ReturnlessUpdate) => {
    updates.push(next)
    args.updates?.(next)
  })

  act(() => {
    root.render(
      <VoiceAudioOutputSection
        voiceSettings={{ ...getDefaultVoiceSettings(), enabled: true }}
        capabilities={
          args.capabilities ?? {
            canMuteOutput: true,
            canDuckOutput: true,
            canPauseMedia: false
          }
        }
        onUpdateVoiceSettings={update}
      />
    )
  })

  return { container, root, updates }
}

type ReturnlessUpdate = Record<string, unknown>

describe('VoiceAudioOutputSection', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('disables unsupported media pause controls', () => {
    const { container, root } = renderSection()

    const pauseSwitch = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Pause playing media when dictation starts"]'
    )
    expect(pauseSwitch?.disabled).toBe(true)
    expect(container.textContent).toContain('Not supported on this platform yet.')

    root.unmount()
  })

  it('describes supported media pause controls', () => {
    const { container, root } = renderSection({
      capabilities: {
        canMuteOutput: true,
        canDuckOutput: true,
        canPauseMedia: true
      }
    })

    expect(container.textContent).toContain('Pauses supported media apps before listening.')

    root.unmount()
  })

  it('saves mute and duck as mutually exclusive output modes', () => {
    const update = vi.fn()

    VoiceAudioOutputSection.applyOutputVolumeModeUpdate(update, 'mute')
    VoiceAudioOutputSection.applyOutputVolumeModeUpdate(update, 'duck')

    expect(update).toHaveBeenCalledWith({ outputVolumeMode: 'mute' })
    expect(update).toHaveBeenCalledWith({ outputVolumeMode: 'duck' })
  })

  it('clamps slider updates before saving percent', () => {
    const update = vi.fn()
    renderSection({ updates: update })

    VoiceAudioOutputSection.applyDuckedVolumeUpdate(update, 115)
    VoiceAudioOutputSection.applyDuckedVolumeUpdate(update, -10)

    expect(update).toHaveBeenCalledWith({ duckedVolumePercent: 100 })
    expect(update).toHaveBeenCalledWith({ duckedVolumePercent: 0 })
  })

  it('matches settings search for volume mute duck and pause media', () => {
    const entry = getVoiceAudioOutputSearchEntry()
    const searchable = [entry.title, entry.description, ...(entry.keywords ?? [])]
      .join(' ')
      .toLowerCase()

    expect(searchable).toContain('volume')
    expect(searchable).toContain('mute')
    expect(searchable).toContain('duck')
    expect(searchable).toContain('pause media')
  })
})
