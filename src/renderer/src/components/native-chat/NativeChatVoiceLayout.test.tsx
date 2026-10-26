// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useEffect, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatVoiceLayout } from './NativeChatVoiceLayout'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
afterEach(cleanup)

it('keeps voice capture and retained words alive while reading updated conversation history', () => {
  const stopCapture = vi.fn()
  function VoiceControls() {
    const [draft, setDraft] = useState('')
    useEffect(() => stopCapture, [])
    return (
      <input aria-label="Retained words" value={draft} onChange={(e) => setDraft(e.target.value)} />
    )
  }
  const view = (reply: string) => (
    <NativeChatVoiceLayout history={<p>{reply}</p>}>
      <VoiceControls />
    </NativeChatVoiceLayout>
  )
  const { rerender, unmount } = render(view('First reply'))
  fireEvent.change(screen.getByLabelText('Retained words'), {
    target: { value: 'My next question' }
  })
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Conversation history' }), { button: 0 })
  expect(screen.getByRole('tabpanel', { name: 'Conversation history' })).toHaveTextContent(
    'First reply'
  )
  rerender(view('Updated reply'))
  expect(screen.getByRole('tabpanel', { name: 'Conversation history' })).toHaveTextContent(
    'Updated reply'
  )
  expect(stopCapture).not.toHaveBeenCalled()
  fireEvent.mouseDown(screen.getByRole('tab', { name: 'Voice' }), { button: 0 })
  expect(screen.getByLabelText('Retained words')).toHaveValue('My next question')
  expect(stopCapture).not.toHaveBeenCalled()
  unmount()
  expect(stopCapture).toHaveBeenCalledOnce()
})
