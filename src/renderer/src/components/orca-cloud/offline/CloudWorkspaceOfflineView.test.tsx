// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudOfflineSnapshot } from '../../../../../shared/hosted-sandbox/cloud-workspace-offline-api'
import { CloudWorkspaceOfflineView, type CloudOfflineViewProps } from './CloudWorkspaceOfflineView'

const NOW = 1_800_000_000_000

const snapshot: CloudOfflineSnapshot = {
  workspaceId: 'ws',
  asleep: false,
  capturedAt: NOW - 2_000,
  git: null,
  terminals: [],
  chats: [
    {
      sessionId: 's1',
      at: NOW - 2_000,
      title: 'Fix the build',
      messages: [{ itemId: 'm1', role: 'user', text: 'Fix the build', at: NOW - 60_000 }]
    }
  ]
}

function view(over: Partial<CloudOfflineViewProps> = {}) {
  const props: CloudOfflineViewProps = {
    snapshot,
    queued: [],
    workspaceName: 'hello-world',
    now: NOW,
    onWake: vi.fn(),
    onQueue: vi.fn(async () => true),
    onCancel: vi.fn(),
    onEdit: vi.fn(async () => true),
    ...over
  }
  return { props, ...render(<CloudWorkspaceOfflineView {...props} />) }
}

describe('the asleep view kept on screen after Sleep', () => {
  afterEach(cleanup)

  it('says "Going to sleep…" while the sleep runs, then "Asleep · As of just now"', () => {
    const { container, rerender, props } = view({ goingToSleep: true, viewOnly: true })
    expect(container.textContent).toContain('Going to sleep…')
    expect(container.textContent).not.toContain('Asleep ·')
    rerender(<CloudWorkspaceOfflineView {...props} goingToSleep={false} />)
    expect(container.textContent).toContain('Asleep · As of just now')
  })

  it('turns the composer off with a "Wake to continue" hint; only the Wake button wakes it', () => {
    const { getByRole, getByPlaceholderText, props } = view({ viewOnly: true })
    const composer = getByPlaceholderText('Wake to continue')
    expect(composer).toHaveProperty('disabled', true)
    fireEvent.click(getByRole('button', { name: 'Send and wake' }))
    expect(props.onQueue).not.toHaveBeenCalled()
    expect(props.onWake).not.toHaveBeenCalled()
    fireEvent.click(getByRole('button', { name: 'Wake to continue' }))
    expect(props.onWake).toHaveBeenCalledTimes(1)
  })

  it('while going to sleep: says the copy is being saved, and offers Keep awake, not Wake', () => {
    const onKeepAwake = vi.fn()
    const { container, getByRole, queryByRole, rerender, props } = view({
      snapshot: { ...snapshot, capturedAt: null, chats: [] },
      goingToSleep: true,
      viewOnly: true,
      onKeepAwake
    })
    expect(container.textContent).toContain(
      'Saving a read-only copy of chats, terminals and changes…'
    )
    expect(queryByRole('button', { name: 'Wake to continue' })).toBeNull()
    fireEvent.click(getByRole('button', { name: 'Keep awake' }))
    expect(onKeepAwake).toHaveBeenCalledTimes(1)
    expect(props.onWake).not.toHaveBeenCalled()
    rerender(<CloudWorkspaceOfflineView {...props} goingToSleep={false} />)
    expect(queryByRole('button', { name: 'Keep awake' })).toBeNull()
    expect(getByRole('button', { name: 'Wake to continue' })).toBeTruthy()
    expect(container.textContent).not.toContain('Saving a read-only copy')
  })

  it('with an earlier copy on screen, the header note says the new copy is being saved', () => {
    // The copy shown is from before (local), while the sleep saves a new one.
    const { container, rerender, props } = view({ goingToSleep: true, viewOnly: true })
    expect(container.textContent).toContain(
      'Saving a read-only copy of chats, terminals and changes…'
    )
    expect(container.textContent).not.toContain('Read-only copy saved when it went to sleep.')
    rerender(<CloudWorkspaceOfflineView {...props} goingToSleep={false} />)
    expect(container.textContent).not.toContain('Saving a read-only copy')
    expect(container.textContent).toContain('Read-only copy saved when it went to sleep.')
  })

  it('once main commits the suspend (no Keep awake handler) offers Wake to continue instead', () => {
    const { getByRole, queryByRole, props } = view({ goingToSleep: true, viewOnly: true })
    expect(queryByRole('button', { name: 'Keep awake' })).toBeNull()
    fireEvent.click(getByRole('button', { name: 'Wake to continue' }))
    expect(props.onWake).toHaveBeenCalledTimes(1)
  })
})
