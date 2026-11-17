// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { useAppStore } from '@/store/index'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  useNativeChatComposerKeyDown,
  type UseNativeChatComposerKeyDownArgs
} from './use-native-chat-composer-keydown'

type ComposerProps = Pick<UseNativeChatComposerKeyDownArgs, 'hasAttachments'> & {
  autocomplete?: UseNativeChatComposerKeyDownArgs['autocomplete']
}

const NO_AUTOCOMPLETE = { mode: 'none' } as const

function Composer({ hasAttachments, autocomplete = NO_AUTOCOMPLETE }: ComposerProps) {
  const [draft, setDraft] = useState('')
  const [delivered, setDelivered] = useState('')
  const [steered, setSteered] = useState(false)
  const handleKeyDown = useNativeChatComposerKeyDown({
    hasAttachments,
    draft,
    autocomplete,
    mentionFiles: { files: [], loading: false, failed: false },
    activeSuggestion: 0,
    completeMention: setDraft,
    isComposing: () => false,
    completePickerItem: (item) => setDraft(`${item.token} `),
    dispatchPickerCommand: (item) => setDelivered(`command:${item.token}`),
    dismissPicker: () => {},
    interrupt: () => {},
    send: (intent) => {
      setDelivered((intent?.alternate ? 'alternate:' : 'send:') + (draft || '[image]'))
      setDraft('')
    },
    steerHead: () => {
      setSteered(true)
      return true
    },
    chordSteersHead: true,
    setActiveSuggestion: () => {},
    setDraft,
    setCaret: () => {}
  })
  return (
    <>
      <textarea
        aria-label="Prompt"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <output data-testid="delivery">{delivered}</output>
      <output data-testid="steered">{steered ? 'steered' : ''}</output>
    </>
  )
}

beforeEach(() => {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/home/test'), nativeChatSendKey: 'shift-enter' }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the native chat send key', () => {
  it('keeps a multiline draft until Shift+Enter, and restores Enter submission when changed back', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    await user.type(prompt, 'first{Enter}second')
    expect(prompt.value).toBe('first\nsecond')
    expect(screen.getByTestId('delivery').textContent).toBe('')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(screen.getByTestId('delivery').textContent).toBe('send:first\nsecond')
    expect(prompt.value).toBe('')

    act(() => useAppStore.setState({ settings: getDefaultSettings('/home/test') }))
    await user.type(prompt, 'again{Enter}')
    expect(screen.getByTestId('delivery').textContent).toBe('send:again')
  })

  it('completes a command with Enter or Tab, but dispatches it only with Shift+Enter', () => {
    render(
      <Composer
        autocomplete={{
          mode: 'slash',
          query: 'hel',
          triggerKey: '/:0',
          prefix: '/',
          dispatchable: true,
          grouped: false,
          commandsEnabled: true,
          skillsEnabled: false,
          skillStatus: 'ready',
          items: [
            { kind: 'command', id: 'help', name: 'help', token: '/help', skillCollision: false }
          ]
        }}
      />
    )
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    fireEvent.keyDown(prompt, { key: 'Enter' })
    expect(prompt.value).toBe('/help ')
    expect(screen.getByTestId('delivery').textContent).toBe('')
    fireEvent.keyDown(prompt, { key: 'Tab' })
    expect(screen.getByTestId('delivery').textContent).toBe('')
    fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true })
    expect(screen.getByTestId('delivery').textContent).toBe('command:/help')
  })

  it('does not submit an IME-owned Shift+Enter, then submits the committed Korean draft', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    await user.type(prompt, '한글')
    fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true, isComposing: true })
    fireEvent.keyDown(prompt, { key: 'Enter', shiftKey: true, keyCode: 229 })
    expect(prompt.value).toBe('한글')
    expect(screen.getByTestId('delivery').textContent).toBe('')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(screen.getByTestId('delivery').textContent).toBe('send:한글')
  })

  it.each([
    ['Macintosh', 'Meta'],
    ['Windows', 'Control']
  ])('preserves the alternate-send and queued-card chords on %s', async (platform, modifier) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
    const user = userEvent.setup()
    render(<Composer />)
    const prompt = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt' })
    await user.type(prompt, 'normal')
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(screen.getByTestId('delivery').textContent).toBe('send:normal')
    await user.type(prompt, 'follow up')
    await user.keyboard(`{${modifier}>}{Enter}{/${modifier}}`)
    expect(screen.getByTestId('delivery').textContent).toBe('alternate:follow up')
    await user.type(prompt, 'unfinished')
    await user.keyboard(`{${modifier}>}{Shift>}{Enter}{/Shift}{/${modifier}}`)
    expect(screen.getByTestId('steered').textContent).toBe('steered')
    expect(prompt.value).toBe('unfinished')
  })

  it('submits an attachment-only draft with Shift+Enter', async () => {
    const user = userEvent.setup()
    render(<Composer hasAttachments />)
    await user.click(screen.getByRole('textbox', { name: 'Prompt' }))
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(screen.getByTestId('delivery').textContent).toBe('send:[image]')
  })
})
