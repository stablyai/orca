// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AutomationOwnerConflictNotice,
  ownerConflictNotice,
  actionBlockNotice
} from './AutomationOwnerConflictNotice'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('AutomationOwnerConflictNotice', () => {
  it('renders nothing when notice is null', () => {
    act(() => {
      root.render(<AutomationOwnerConflictNotice notice={null} />)
    })
    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders warning notice message and icon', () => {
    const notice = ownerConflictNotice({
      code: 'automation_owner_changed',
      message: 'Editing automations on this host requires a newer Orca server.',
      recovery: 'update-server'
    })

    act(() => {
      root.render(<AutomationOwnerConflictNotice notice={notice} />)
    })

    const alert = container.querySelector('[role="alert"][data-testid="automation-owner-conflict"]')
    expect(alert).not.toBeNull()
    expect(alert?.textContent).toContain(
      'Editing automations on this host requires a newer Orca server.'
    )
    expect(alert?.querySelector('svg')).not.toBeNull()
  })

  it('renders recovery button when onRecover is provided and handles click', () => {
    const onRecover = vi.fn()
    const notice = ownerConflictNotice({
      code: 'automation_owner_changed',
      message: 'Host needs update',
      recovery: 'update-server'
    })

    act(() => {
      root.render(<AutomationOwnerConflictNotice notice={notice} onRecover={onRecover} />)
    })

    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Update server')

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRecover).toHaveBeenCalledWith('update-server')
  })

  it('renders dismiss button when onDismiss is provided and handles click', () => {
    const onDismiss = vi.fn()
    const notice = actionBlockNotice({
      reason: 'orphan',
      message: 'Action blocked',
      recovery: null
    })

    act(() => {
      root.render(<AutomationOwnerConflictNotice notice={notice} onDismiss={onDismiss} />)
    })

    const button = container.querySelector('button')
    expect(button?.textContent).toBe('Dismiss')

    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('renders both recovery and dismiss buttons when both are configured', () => {
    const onRecover = vi.fn()
    const onDismiss = vi.fn()
    const notice = ownerConflictNotice({
      code: 'automation_owner_changed',
      message: 'Host conflict',
      recovery: 'retry'
    })

    act(() => {
      root.render(
        <AutomationOwnerConflictNotice
          notice={notice}
          onRecover={onRecover}
          onDismiss={onDismiss}
        />
      )
    })

    const buttons = container.querySelectorAll('button')
    expect(buttons.length).toBe(2)
    expect(buttons[0]?.textContent).toBe('Retry')
    expect(buttons[1]?.textContent).toBe('Dismiss')
  })
})
