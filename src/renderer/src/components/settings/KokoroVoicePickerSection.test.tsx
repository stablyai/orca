// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { VoiceSettings } from '../../../../shared/speech-types'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import {
  FALLBACK_VOICE_IDS,
  describeVoiceId
} from '../../lib/voice/desktop-kokoro-voices'

const mocks = vi.hoisted(() => {
  const speak = vi.fn(async () => {})
  const setHostEndpoint = vi.fn()
  const stop = vi.fn()
  return { speak, setHostEndpoint, stop }
})

vi.mock('../../lib/voice/desktop-mesh-speech', () => ({
  DesktopMeshSpeaker: class {
    speak = mocks.speak
    setHostEndpoint = mocks.setHostEndpoint
    stop = mocks.stop
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { KokoroVoicePickerSection } from './KokoroVoicePickerSection'

const mockVoicesBody = {
  voices: [{ id: 'af_heart' }, { id: 'am_onyx' }, { id: 'bf_emma' }]
}

function stubFetchWith(handler: () => Promise<Response>): void {
  vi.stubGlobal('fetch', vi.fn(handler) as unknown as typeof fetch)
}

function stubFetchVoices(): void {
  stubFetchWith(async () =>
    new Response(JSON.stringify(mockVoicesBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  )
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
  await act(async () => {
    await Promise.resolve()
  })
}

async function renderPicker(args: {
  kokoroVoice?: string
  hostEndpoint?: string | null
  onUpdateVoiceSettings?: (updates: Partial<VoiceSettings>) => void
}): Promise<{ container: HTMLDivElement; root: Root; update: Mock<(updates: Partial<VoiceSettings>) => void> }> {
  const voiceSettings: VoiceSettings = {
    ...getDefaultVoiceSettings(),
    kokoroVoice: args.kokoroVoice ?? getDefaultVoiceSettings().kokoroVoice
  }
  const update: Mock<(updates: Partial<VoiceSettings>) => void> =
    (args.onUpdateVoiceSettings as Mock<(updates: Partial<VoiceSettings>) => void>) ?? vi.fn()

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <KokoroVoicePickerSection
        voiceSettings={voiceSettings}
        hostEndpoint={args.hostEndpoint ?? null}
        onUpdateVoiceSettings={update}
      />
    )
  })
  await flush()
  return { container, root, update }
}

describe('KokoroVoicePickerSection', () => {
  beforeEach(() => {
    mocks.speak.mockClear()
    mocks.setHostEndpoint.mockClear()
    mocks.stop.mockClear()
    stubFetchVoices()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.innerHTML = ''
  })

  it('renders the fetched catalogue grouped by language', async () => {
    const { container, root } = await renderPicker({})
    expect(container.textContent).toContain('Heart')
    expect(container.textContent).toContain('Onyx')
    expect(container.textContent).toContain('Emma')
    expect(container.textContent).toContain('American English')
    expect(container.textContent).toContain('British English')
    root.unmount()
  })

  it('marks the persisted voice as the selected radio', async () => {
    const { container, root } = await renderPicker({ kokoroVoice: 'am_onyx' })
    const checked = container.querySelectorAll<HTMLButtonElement>(
      'button[role="radio"][aria-checked="true"]'
    )
    expect(checked).toHaveLength(1)
    expect(checked[0].getAttribute('aria-label')).toContain('Onyx')
    root.unmount()
  })

  it('falls back to FALLBACK_VOICE_IDS when the catalogue fetch fails', async () => {
    stubFetchWith(async () => {
      throw new Error('network down')
    })

    const { container, root } = await renderPicker({})
    for (const id of FALLBACK_VOICE_IDS) {
      const voice = describeVoiceId(id)
      expect(container.textContent).toContain(voice.label)
    }
    root.unmount()
  })

  it('clicking a row persists the choice and previews the chosen voice', async () => {
    mocks.speak.mockResolvedValue(undefined)
    const { container, root, update } = await renderPicker({
      kokoroVoice: 'af_heart'
    })

    const onyxRow = [
      ...container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')
    ].find((btn) => btn.getAttribute('aria-label')?.includes('Onyx'))
    expect(onyxRow).toBeDefined()

    await act(async () => {
      onyxRow!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()

    expect(update).toHaveBeenCalledWith({ kokoroVoice: 'am_onyx' })
    expect(mocks.setHostEndpoint).toHaveBeenCalled()
    expect(mocks.speak).toHaveBeenCalledWith(
      expect.stringContaining("I'm Onyx"),
      expect.objectContaining({ voice: 'am_onyx' })
    )
    root.unmount()
  })

  it('treats an empty persisted voice as the default', async () => {
    // Why: an older persisted profile may have kokoroVoice='' before this field
    // shipped; the picker should still highlight the default id rather than
    // rendering no selection at all.
    const { container, root } = await renderPicker({ kokoroVoice: '' })
    const checked = container.querySelectorAll<HTMLButtonElement>(
      'button[role="radio"][aria-checked="true"]'
    )
    expect(checked).toHaveLength(1)
    expect(checked[0].getAttribute('aria-label')).toContain('Heart')
    root.unmount()
  })
})
