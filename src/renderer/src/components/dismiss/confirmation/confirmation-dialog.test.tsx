// @vitest-environment happy-dom
// The confirmation prompt's opening-gesture guard: a key held or clicks still coming from what
// opened it are not an answer, and nothing about them makes a later, independent answer unusable.
import { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from './confirmation-dialog'
import {
  useConfirmationDialog,
  type ConfirmationDialogContextValue,
  type ConfirmationDialogOptions
} from './confirmation-dialog-context'

let ask: ConfirmationDialogContextValue = () => Promise.resolve(false)
function Asker(): null {
  ask = useConfirmationDialog()
  return null
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  render(
    <ConfirmationDialogProvider>
      <Asker />
    </ConfirmationDialogProvider>
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type Asked = { answers: boolean[]; cancelClicked: ReturnType<typeof vi.fn<() => void>> }

/** Opens one prompt; its answers (and Cancel presses) are recorded as they come. */
async function open(options: Partial<ConfirmationDialogOptions> = {}): Promise<Asked> {
  const asked: Asked = { answers: [], cancelClicked: vi.fn<() => void>() }
  await act(async () => {
    void ask({
      title: 'Share the folder?',
      confirmLabel: 'Share',
      onCancelClicked: asked.cancelClicked,
      ...options
    }).then((answer) => asked.answers.push(answer))
  })
  // The dialog's surface loads on first use: the prompt is up once its buttons are.
  await screen.findByRole('button', { name: 'Share' })
  return asked
}

const button = (name: 'Cancel' | 'Share'): HTMLElement => screen.getByRole('button', { name })
const prompt = (): HTMLElement | null => screen.queryByRole('button', { name: 'Share' })
/** A click no key or pointer press came with (assistive tech, `element.click()`). */
const keylessClick = async (name: 'Cancel' | 'Share'): Promise<void> => {
  await act(async () => {
    button(name).click()
  })
}
const strayRelease = (name: 'Cancel' | 'Share'): boolean =>
  fireEvent.keyUp(button(name), { key: ' ' })

const answerOf = { Share: true, Cancel: false } as const

describe.each([['buttons' as const], [true as const]])('guarded (%s)', (mode) => {
  it('withholds a Space release with no press since it opened, on either button', async () => {
    const asked = await open({ ignoresOpeningGesture: mode })
    expect(strayRelease('Cancel')).toBe(false)
    expect(strayRelease('Share')).toBe(false)
    expect(prompt()).toBeTruthy()
    expect(asked.answers).toEqual([])
  })

  for (const [released, answered] of [
    ['Cancel', 'Cancel'],
    ['Share', 'Share'],
    ['Cancel', 'Share'],
    ['Share', 'Cancel']
  ] as const) {
    it(`after a stray release on ${released}, a key-less click on ${answered} answers`, async () => {
      const asked = await open({ ignoresOpeningGesture: mode })
      strayRelease(released)
      button(answered).focus()
      await keylessClick(answered)
      expect(asked.answers).toEqual([answerOf[answered]])
      expect(asked.cancelClicked).toHaveBeenCalledTimes(answered === 'Cancel' ? 1 : 0)
      expect(prompt()).toBeNull()
    })
  }

  it('after a stray release, a fresh Space on the button answers', async () => {
    const asked = await open({ ignoresOpeningGesture: mode })
    strayRelease('Share')
    button('Share').focus()
    await act(async () => userEvent.setup().keyboard('[Space]'))
    expect(asked.answers).toEqual([true])
  })

  it('after a stray release on one prompt, the next queued prompt answers a key-less click', async () => {
    const first = await open({ ignoresOpeningGesture: mode })
    const second = await open({ ignoresOpeningGesture: mode })
    strayRelease('Share')
    await keylessClick('Share')
    expect(first.answers).toEqual([true])
    // The queued prompt is up now; its own stray release is withheld, its click still answers.
    expect(strayRelease('Share')).toBe(false)
    await keylessClick('Cancel')
    expect(second.answers).toEqual([false])
    expect(second.cancelClicked).toHaveBeenCalledOnce()
  })

  it('ignores a held Enter and a multi-click, and answers a fresh Enter', async () => {
    const asked = await open({ ignoresOpeningGesture: mode })
    expect(fireEvent.keyDown(button('Share'), { key: 'Enter', repeat: true })).toBe(false)
    fireEvent.click(button('Share'), { detail: 2 })
    expect(asked.answers).toEqual([])
    button('Share').focus()
    await act(async () => userEvent.setup().keyboard('{Enter}'))
    expect(asked.answers).toEqual([true])
  })

  it('answers a fresh pointer press', async () => {
    const asked = await open({ ignoresOpeningGesture: mode })
    await act(async () => userEvent.setup().click(button('Cancel')))
    expect(asked.answers).toEqual([false])
    expect(asked.cancelClicked).toHaveBeenCalledOnce()
  })

  it('Escape dismisses it without counting as a Cancel press', async () => {
    const asked = await open({ ignoresOpeningGesture: mode })
    await act(async () => userEvent.setup().keyboard('{Escape}'))
    expect(asked.answers).toEqual([false])
    expect(asked.cancelClicked).not.toHaveBeenCalled()
  })

  it('starts on Cancel, on the verb when asked, and Enter in a field confirms once', async () => {
    await open({ ignoresOpeningGesture: mode })
    expect(document.activeElement).toBe(button('Cancel'))
    await keylessClick('Cancel')
    await open({ ignoresOpeningGesture: mode, initialFocus: 'confirm' })
    expect(document.activeElement).toBe(button('Share'))
    await keylessClick('Cancel')
    const onConfirmed = vi.fn()
    const asked = await open({
      ignoresOpeningGesture: mode,
      fields: { inputs: [{ id: 'name', label: 'Name', defaultValue: 'docs' }], onConfirmed }
    })
    const field = screen.getByLabelText('Name')
    expect(document.activeElement).toBe(field)
    fireEvent.keyDown(field, { key: 'Enter', repeat: true })
    expect(asked.answers).toEqual([])
    await act(async () => {
      fireEvent.keyDown(field, { key: 'Enter' })
    })
    expect(asked.answers).toEqual([true])
    expect(onConfirmed).toHaveBeenCalledWith({ name: 'docs' })
  })
})

describe('unguarded', () => {
  it('leaves Space releases, repeats and multi-clicks to the button', async () => {
    const asked = await open()
    expect(strayRelease('Share')).toBe(true)
    expect(fireEvent.keyDown(button('Share'), { key: 'Enter', repeat: true })).toBe(true)
    await act(async () => {
      fireEvent.click(button('Share'), { detail: 2 })
    })
    expect(asked.answers).toEqual([true])
  })
})
