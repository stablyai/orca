// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog } from '@/components/ui/dialog'
import { CloneStep } from './AddRepoCloneStep'

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

function dispatchRecordedGesture(input: HTMLInputElement): boolean {
  fireEvent.compositionStart(input)
  dispatchKey(input, 'keydown', {
    key: 'Process',
    code: 'Enter',
    keyCode: 229,
    isComposing: true
  })
  fireEvent.compositionEnd(input, { data: '가' })
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

function renderStep(onClone: () => void): HTMLInputElement {
  const view = render(
    <Dialog open>
      <CloneStep
        cloneUrl="git@example.test:repo.git"
        cloneDestination="/tmp/테스"
        cloneError={null}
        cloneProgress={null}
        isCloning={false}
        onUrlChange={() => {}}
        onDestChange={() => {}}
        onPickDestination={() => {}}
        onClone={onClone}
      />
    </Dialog>
  )
  return view.getByPlaceholderText('/path/to/destination') as HTMLInputElement
}

afterEach(cleanup)

describe('CloneStep IME Enter ownership', () => {
  it('does not clone on the recorded Korean Enter redispatch', () => {
    const onClone = vi.fn()
    const input = renderStep(onClone)

    expect(dispatchRecordedGesture(input)).toBe(true)
    expect(onClone).not.toHaveBeenCalled()
  })

  it('clones exactly once on ordinary Enter', () => {
    const onClone = vi.fn()
    const input = renderStep(onClone)

    dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onClone).toHaveBeenCalledOnce()
  })
})
