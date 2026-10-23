// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { VoiceTranscriptEntry } from '../../../../shared/voice-control-types'
import { VoiceControlTranscriptPanel } from './VoiceControlTranscriptPanel'
import {
  publishVoiceControlState,
  publishVoiceControlTranscriptEntry,
  resetVoiceControl,
  setVoiceControlTranscriptPanelOpen
} from './voice-control-store'

const getTranscriptMock = vi.fn<(typeof window.api.voiceControl)['getTranscript']>()
const sendUserTextMock = vi.fn<(typeof window.api.voiceControl)['sendUserText']>()

beforeEach(() => {
  getTranscriptMock.mockReset()
  getTranscriptMock.mockResolvedValue([])
  sendUserTextMock.mockReset()
  sendUserTextMock.mockResolvedValue()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the panel reads only voiceControl.getTranscript/sendUserText; the rest of window.api is fixture weight.
  window.api = {
    voiceControl: { getTranscript: getTranscriptMock, sendUserText: sendUserTextMock }
  } as unknown as typeof window.api
})

afterEach(() => {
  cleanup()
  resetVoiceControl()
})

function openPanel(): void {
  act(() => {
    publishVoiceControlState({ sessionId: 's1', state: 'live' })
    setVoiceControlTranscriptPanelOpen(true)
  })
}

describe('VoiceControlTranscriptPanel', () => {
  it('renders nothing until opened, and hides with the pill when the session idles', () => {
    render(<VoiceControlTranscriptPanel />)
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
    })
    expect(screen.queryByTestId('voice-control-transcript-panel')).not.toBeInTheDocument()
    openPanel()
    expect(screen.getByTestId('voice-control-transcript-panel')).toBeInTheDocument()
    act(() => {
      publishVoiceControlState({ sessionId: null, state: 'idle' })
    })
    expect(screen.queryByTestId('voice-control-transcript-panel')).not.toBeInTheDocument()
  })

  it('backfills from the durable log when opened', async () => {
    const backfill: VoiceTranscriptEntry[] = [
      { ts: 1, kind: 'user', text: 'clone the repo' },
      { ts: 2, kind: 'assistant', text: 'on it' }
    ]
    getTranscriptMock.mockResolvedValue(backfill)
    render(<VoiceControlTranscriptPanel />)
    openPanel()
    expect(getTranscriptMock).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('clone the repo')).toBeInTheDocument()
    expect(screen.getByText('on it')).toBeInTheDocument()
  })

  it('renders live entries of every kind as they stream in', async () => {
    render(<VoiceControlTranscriptPanel />)
    openPanel()
    await act(async () => {})
    act(() => {
      publishVoiceControlTranscriptEntry({ ts: 10, kind: 'user', text: 'did the clone finish?' })
      publishVoiceControlTranscriptEntry({ ts: 11, kind: 'assistant', text: 'checking now' })
      publishVoiceControlTranscriptEntry({
        ts: 12,
        kind: 'command',
        command: 'git status --short',
        cwd: '/tmp/x',
        output: 'clean'
      })
      publishVoiceControlTranscriptEntry({
        ts: 13,
        kind: 'update',
        spokenName: 'oak',
        text: 'reports done'
      })
      publishVoiceControlTranscriptEntry({
        ts: 14,
        kind: 'ui',
        summary: 'Clicked "Assigned to me".'
      })
    })
    expect(screen.getByTestId('transcript-entry-user')).toHaveTextContent('did the clone finish?')
    expect(screen.getByTestId('transcript-entry-assistant')).toHaveTextContent('checking now')
    const command = screen.getByTestId('transcript-entry-command')
    expect(command).toHaveTextContent('$ git status --short')
    expect(command).toHaveTextContent('clean')
    expect(screen.getByTestId('transcript-entry-update')).toHaveTextContent('oak — reports done')
    expect(screen.getByTestId('transcript-entry-ui')).toHaveTextContent('Clicked "Assigned to me".')
  })

  it('keeps live entries that landed while the backfill was in flight', async () => {
    let resolveBackfill: (entries: VoiceTranscriptEntry[]) => void = () => {}
    getTranscriptMock.mockImplementation(
      () =>
        new Promise<VoiceTranscriptEntry[]>((resolve) => {
          resolveBackfill = resolve
        })
    )
    render(<VoiceControlTranscriptPanel />)
    openPanel()
    act(() => {
      publishVoiceControlTranscriptEntry({ ts: 99, kind: 'user', text: 'live during fetch' })
    })
    await act(async () => {
      resolveBackfill([{ ts: 1, kind: 'assistant', text: 'from the log' }])
    })
    expect(screen.getByText('from the log')).toBeInTheDocument()
    expect(screen.getByText('live during fetch')).toBeInTheDocument()
  })

  it('closes from its own button', async () => {
    render(<VoiceControlTranscriptPanel />)
    openPanel()
    await act(async () => {})
    act(() => {
      screen.getByRole('button', { name: 'Close transcript' }).click()
    })
    expect(screen.queryByTestId('voice-control-transcript-panel')).not.toBeInTheDocument()
  })

  // Live failure this guards: the user had an OAuth code to paste and the session had no
  // text lane at all — the composer is the lane, and it must trim and clear on send.
  it('sends the composer draft as a typed user message and clears it', () => {
    render(<VoiceControlTranscriptPanel />)
    openPanel()
    const input = screen.getByPlaceholderText('Type or paste a message…')
    fireEvent.change(input, { target: { value: '  the code is abc-123  ' } })
    act(() => {
      screen.getByRole('button', { name: 'Send message' }).click()
    })
    expect(sendUserTextMock).toHaveBeenCalledTimes(1)
    expect(sendUserTextMock).toHaveBeenCalledWith('s1', 'the code is abc-123')
    expect(input).toHaveValue('')
  })

  it('hides the composer outside a live session and never sends a blank draft', () => {
    render(<VoiceControlTranscriptPanel />)
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'minting' })
      setVoiceControlTranscriptPanelOpen(true)
    })
    expect(screen.getByTestId('voice-control-transcript-panel')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Type or paste a message…')).not.toBeInTheDocument()
    act(() => {
      publishVoiceControlState({ sessionId: 's1', state: 'live' })
    })
    fireEvent.change(screen.getByPlaceholderText('Type or paste a message…'), {
      target: { value: '   ' }
    })
    const sendButton = screen.getByRole('button', { name: 'Send message' })
    expect(sendButton).toBeDisabled()
    fireEvent.submit(sendButton)
    expect(sendUserTextMock).not.toHaveBeenCalled()
  })
})
