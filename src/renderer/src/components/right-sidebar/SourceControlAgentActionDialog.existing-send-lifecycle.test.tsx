// @vitest-environment happy-dom

import React, { type ReactNode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceControlLaunchActionId } from '../../../../shared/source-control-ai-actions'

type SendCallbacks = {
  onSendStarted: () => void
  onPromptDelivered: () => void
  onSendFailed: () => void
}

const mocks = vi.hoisted(() => {
  const sends: SendCallbacks[] = []
  return {
    sends,
    handleOpenChange: vi.fn(),
    onLaunchAccepted: vi.fn(),
    onLaunched: vi.fn(),
    onLaunchAborted: vi.fn()
  }
})

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    React.createElement('p', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => React.createElement('h2', null, children)
}))
// Why: the lifecycle guard lives in the dialog shell, so the launch hook and form are stubbed.
vi.mock('./useSourceControlAgentActionDialog', () => ({
  useSourceControlAgentActionDialog: () => ({
    handleOpenChange: mocks.handleOpenChange,
    shouldRenderDialog: true,
    trimmedCommandInput: 'Resolve the PR comments.',
    connectionUnavailable: false,
    canStart: true,
    isStarting: false,
    handleStart: vi.fn()
  })
}))
vi.mock('./SourceControlAgentActionDialogForm', () => ({
  SourceControlAgentActionDialogForm: ({
    canStart,
    existingAgentSendMenu
  }: {
    canStart: boolean
    existingAgentSendMenu?: ReactNode
  }) =>
    React.createElement(
      'div',
      null,
      React.createElement('button', { 'data-start': 'true', disabled: !canStart }, 'Start agent'),
      existingAgentSendMenu
    )
}))
vi.mock('./SourceControlExistingAgentSendMenu', () => ({
  SourceControlExistingAgentSendMenu: ({
    disabled,
    onSendStarted,
    onPromptDelivered,
    onSendFailed
  }: SendCallbacks & { disabled: boolean }) =>
    React.createElement(
      'button',
      {
        'data-send': 'true',
        disabled,
        onClick: () => {
          mocks.sends.push({ onSendStarted, onPromptDelivered, onSendFailed })
          onSendStarted()
        }
      },
      'Send to running agent'
    )
}))

import { SourceControlAgentActionDialog } from './SourceControlAgentActionDialog'

let container: HTMLDivElement
let root: Root

function renderDialog(
  open: boolean,
  actionId: SourceControlLaunchActionId = 'resolveComments'
): void {
  act(() => {
    root.render(
      <SourceControlAgentActionDialog
        open={open}
        onOpenChange={vi.fn()}
        actionId={actionId}
        title="Resolve comments"
        description=""
        baseCommandInput="Resolve the PR comments."
        worktreeId="wt-1"
        launchSource="task_page"
        allowExistingAgentSession
        onLaunchAccepted={mocks.onLaunchAccepted}
        onLaunched={mocks.onLaunched}
        onLaunchAborted={mocks.onLaunchAborted}
      />
    )
  })
}

function button(selector: string): HTMLButtonElement {
  const found = container.querySelector(selector)
  if (!(found instanceof HTMLButtonElement)) {
    throw new Error(`missing ${selector}`)
  }
  return found
}

function startSend(): SendCallbacks {
  act(() => {
    button('[data-send]').click()
  })
  const send = mocks.sends.at(-1)
  if (!send) {
    throw new Error('send did not start')
  }
  return send
}

describe('SourceControlAgentActionDialog existing-session send lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sends.length = 0
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('disables starting while its own send is pending, then closes on delivery', () => {
    renderDialog(true)
    const send = startSend()
    expect(mocks.onLaunchAccepted).toHaveBeenCalledTimes(1)
    expect(button('[data-start]').disabled).toBe(true)
    expect(button('[data-send]').disabled).toBe(true)

    act(() => send.onPromptDelivered())
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.handleOpenChange).toHaveBeenCalledWith(false)
  })

  it('re-enables the same composer after a failed send without closing it', () => {
    renderDialog(true)
    const send = startSend()

    act(() => send.onSendFailed())
    expect(mocks.onLaunchAborted).toHaveBeenCalledTimes(1)
    expect(mocks.handleOpenChange).not.toHaveBeenCalled()
    expect(button('[data-start]').disabled).toBe(false)
    expect(button('[data-send]').disabled).toBe(false)
  })

  it('acks a send delivered after cancel and reopen without closing or disabling the new composer', () => {
    renderDialog(true)
    const send = startSend()
    renderDialog(false)
    renderDialog(true)
    expect(button('[data-start]').disabled).toBe(false)
    expect(button('[data-send]').disabled).toBe(false)

    act(() => send.onPromptDelivered())
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.handleOpenChange).not.toHaveBeenCalled()
    expect(button('[data-start]').disabled).toBe(false)
  })

  it('releases a send that fails after cancel and reopen without touching the new composer', () => {
    renderDialog(true)
    const send = startSend()
    renderDialog(false)
    renderDialog(true)

    act(() => send.onSendFailed())
    expect(mocks.onLaunchAborted).toHaveBeenCalledTimes(1)
    expect(mocks.handleOpenChange).not.toHaveBeenCalled()
    expect(button('[data-start]').disabled).toBe(false)
  })

  it('acks a send delivered after cancel or Escape without closing again', () => {
    renderDialog(true)
    const send = startSend()
    renderDialog(false)

    act(() => send.onPromptDelivered())
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.handleOpenChange).not.toHaveBeenCalled()
  })

  it('keeps a newer send pending when an older send settles', () => {
    renderDialog(true)
    const olderSend = startSend()
    renderDialog(false)
    renderDialog(true)
    const newerSend = startSend()

    act(() => olderSend.onPromptDelivered())
    expect(mocks.handleOpenChange).not.toHaveBeenCalled()
    expect(button('[data-start]').disabled).toBe(true)

    act(() => newerSend.onPromptDelivered())
    expect(mocks.onLaunched).toHaveBeenCalledTimes(2)
    expect(mocks.handleOpenChange).toHaveBeenCalledTimes(1)
    expect(mocks.handleOpenChange).toHaveBeenCalledWith(false)
  })

  it('does not close a composer switched to another action', () => {
    renderDialog(true)
    const send = startSend()
    renderDialog(true, 'fixChecks')
    expect(button('[data-start]').disabled).toBe(false)

    act(() => send.onPromptDelivered())
    expect(mocks.onLaunched).toHaveBeenCalledTimes(1)
    expect(mocks.handleOpenChange).not.toHaveBeenCalled()
    expect(button('[data-start]').disabled).toBe(false)
  })
})
