// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('monaco-editor', () => ({}))
vi.mock('@/lib/monaco-setup', () => ({ monaco: {} }))
vi.mock('@monaco-editor/react', () => ({
  default: () => null,
  DiffEditor: () => null
}))

import { TaskCreationTitleInput } from './TaskPage'

type Surface = {
  name: string
  placeholder: string
  variant?: 'default' | 'plain'
}

const surfaces: Surface[] = [
  { name: 'GitHub issue', placeholder: 'GitHub issue title' },
  { name: 'Linear project', placeholder: 'Linear project name', variant: 'plain' },
  { name: 'Linear issue', placeholder: 'Linear issue title', variant: 'plain' },
  { name: 'Jira issue', placeholder: 'Jira issue title' }
]

function dispatchKey(
  input: HTMLInputElement,
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit
): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => input.dispatchEvent(event))
  return event.defaultPrevented
}

function renderSurface(surface: Surface, onSubmit: (value: string) => void): HTMLInputElement {
  const view = render(
    <TaskCreationTitleInput
      value="테스"
      onChange={() => {}}
      onSubmit={onSubmit}
      placeholder={surface.placeholder}
      disabled={false}
      variant={surface.variant}
    />
  )
  return view.getByPlaceholderText(surface.placeholder) as HTMLInputElement
}

function dispatchRecordedGesture(input: HTMLInputElement): boolean {
  act(() => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  dispatchKey(input, 'keydown', {
    key: 'Process',
    code: 'Enter',
    keyCode: 229,
    isComposing: true
  })
  act(() => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  const prevented = dispatchKey(input, 'keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 13,
    isComposing: false
  })
  dispatchKey(input, 'keyup', { key: 'Process', keyCode: 229 })
  dispatchKey(input, 'keyup', { key: 'Enter', keyCode: 13 })
  return prevented
}

afterEach(cleanup)

describe('TaskPage creation title IME Enter ownership', () => {
  for (const surface of surfaces) {
    it(`${surface.name} does not create on the recorded Korean Enter redispatch`, () => {
      const onSubmit = vi.fn()
      const input = renderSurface(surface, onSubmit)

      expect(dispatchRecordedGesture(input)).toBe(true)
      expect(onSubmit).not.toHaveBeenCalled()
    })

    it(`${surface.name} creates exactly once on ordinary Enter`, () => {
      const onSubmit = vi.fn()
      const input = renderSurface(surface, onSubmit)

      dispatchKey(input, 'keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        isComposing: false
      })

      expect(onSubmit).toHaveBeenCalledOnce()
      expect(onSubmit).toHaveBeenCalledWith('테스')
    })
  }

  it('keeps Jira and Linear issue ownership isolated', () => {
    const onJiraSubmit = vi.fn()
    const onLinearSubmit = vi.fn()
    const view = render(
      <>
        <TaskCreationTitleInput
          value="지라"
          onChange={() => {}}
          onSubmit={onJiraSubmit}
          placeholder="Jira isolation title"
          disabled={false}
        />
        <TaskCreationTitleInput
          value="리니어"
          onChange={() => {}}
          onSubmit={onLinearSubmit}
          placeholder="Linear isolation title"
          disabled={false}
          variant="plain"
        />
      </>
    )
    const jira = view.getByPlaceholderText('Jira isolation title') as HTMLInputElement
    const linear = view.getByPlaceholderText('Linear isolation title') as HTMLInputElement

    act(() => jira.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    dispatchKey(jira, 'keydown', {
      key: 'Process',
      code: 'Enter',
      keyCode: 229,
      isComposing: true
    })
    act(() => jira.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    dispatchKey(linear, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onJiraSubmit).not.toHaveBeenCalled()
    expect(onLinearSubmit).toHaveBeenCalledOnce()
    expect(onLinearSubmit).toHaveBeenCalledWith('리니어')
  })
})
