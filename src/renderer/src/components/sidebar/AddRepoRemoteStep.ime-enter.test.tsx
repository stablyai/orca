// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Dialog } from '@/components/ui/dialog'
import type { SshConnectionState, SshTarget } from '../../../../shared/ssh-types'
import { RemoteStep } from './AddRepoRemoteStep'

const target: SshTarget & { state: SshConnectionState } = {
  id: 'ssh-1',
  label: 'Host',
  host: 'example.test',
  port: 22,
  username: 'user',
  state: {
    targetId: 'ssh-1',
    status: 'connected',
    error: null,
    reconnectAttempt: 0
  }
}

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

function renderStep(onAdd: () => void): HTMLInputElement {
  const view = render(
    <Dialog open>
      <RemoteStep
        sshTargets={[target]}
        selectedTargetId="ssh-1"
        remotePath="/home/user/테스"
        remoteError={null}
        isAddingRemote={false}
        onSelectTarget={() => {}}
        onRemotePathChange={() => {}}
        onAdd={onAdd}
        onOpenSshSettings={() => {}}
        onConnectTarget={async () => {}}
      />
    </Dialog>
  )
  return view.getByPlaceholderText('/home/user/project') as HTMLInputElement
}

afterEach(cleanup)

describe('RemoteStep IME Enter ownership', () => {
  it('does not add on the recorded Korean Enter redispatch', () => {
    const onAdd = vi.fn()
    const input = renderStep(onAdd)

    expect(dispatchRecordedGesture(input)).toBe(true)
    expect(onAdd).not.toHaveBeenCalled()
  })

  it('adds exactly once on ordinary Enter', () => {
    const onAdd = vi.fn()
    const input = renderStep(onAdd)

    dispatchKey(input, 'keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(onAdd).toHaveBeenCalledOnce()
  })
})
