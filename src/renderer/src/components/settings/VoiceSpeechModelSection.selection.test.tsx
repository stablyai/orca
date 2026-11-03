// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { MouseEvent, PropsWithChildren } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { SpeechModelManifest } from '../../../../shared/speech-types'
import { VoiceSpeechModelSection } from './VoiceSpeechModelSection'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('../ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: PropsWithChildren) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: PropsWithChildren<{
    disabled?: boolean
    onSelect?: (event: MouseEvent<HTMLButtonElement>) => void
  }>) => (
    <button disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  )
}))

const downloadModel = vi.fn<() => Promise<void>>()
const catalog: SpeechModelManifest[] = [
  {
    id: 'macos-native',
    label: 'macOS Speech',
    description: 'System speech',
    type: 'macos-native',
    provider: 'macos-native',
    language: 'system',
    sampleRate: 16000,
    streaming: false
  },
  {
    id: 'parakeet',
    label: 'Parakeet',
    description: 'Local speech',
    type: 'nemo-ctc',
    provider: 'local',
    language: 'en',
    sampleRate: 16000,
    streaming: false
  }
]
beforeEach(() => {
  vi.stubGlobal('api', { speech: { downloadModel } })
  downloadModel.mockReset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function section(update: (value: { sttModel?: string }) => void, model = '') {
  return (
    <VoiceSpeechModelSection
      voiceSettings={{ ...getDefaultVoiceSettings(), enabled: true, sttModel: model }}
      catalog={catalog}
      modelStates={catalog.map(({ id }) => ({ id, status: 'ready' }))}
      onUpdateVoiceSettings={update}
      onOpenOpenAiDialog={vi.fn()}
      onRefreshModelStates={vi.fn()}
    />
  )
}

it('keeps a newer model choice when system asset installation finishes later', async () => {
  const pending = Promise.withResolvers<void>()
  downloadModel.mockReturnValue(pending.promise)
  const update = vi.fn()
  render(section(update))
  fireEvent.click(screen.getByRole('button', { name: /macOS Speech/ }))
  fireEvent.click(screen.getByRole('button', { name: /Parakeet/ }))
  await act(async () => pending.resolve())
  expect(update.mock.calls).toEqual([[{ sttModel: 'parakeet' }]])
})

it('does not apply preparation after settings change outside the picker', async () => {
  const pending = Promise.withResolvers<void>()
  downloadModel.mockReturnValue(pending.promise)
  const update = vi.fn()
  const view = render(section(update))
  fireEvent.click(screen.getByRole('button', { name: /macOS Speech/ }))
  view.rerender(section(update, 'parakeet'))
  await act(async () => pending.resolve())
  expect(update).not.toHaveBeenCalled()
})

it('selects system speech once preparation succeeds without another choice', async () => {
  downloadModel.mockResolvedValue(undefined)
  const update = vi.fn()
  render(section(update))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: /macOS Speech/ })))
  expect(update).toHaveBeenCalledExactlyOnceWith({ sttModel: 'macos-native' })
})

it('does not select a model after the settings component is closed', async () => {
  const pending = Promise.withResolvers<void>()
  downloadModel.mockReturnValue(pending.promise)
  const update = vi.fn()
  const view = render(section(update))
  fireEvent.click(screen.getByRole('button', { name: /macOS Speech/ }))
  view.unmount()
  await act(async () => pending.resolve())
  expect(update).not.toHaveBeenCalled()
})
