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

  it('says "Going to sleep · Saving a read-only copy…" while the sleep runs, then "Asleep · As of just now"', () => {
    const { container, rerender, props } = view({ goingToSleep: true, viewOnly: true })
    expect(container.textContent).toContain('Going to sleep · Saving a read-only copy…')
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
    expect(container.textContent).toContain('Saving a read-only copy…')
    expect(container.textContent).toContain(
      'Terminals, chats and changes will be readable here in a moment.'
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

  it('with an earlier copy, shows the saving state (not that older copy) until the new one is in', () => {
    // The copy from before is not the one going to sleep; the saving state replaces it meanwhile.
    const { container, rerender, props } = view({ goingToSleep: true, viewOnly: true })
    expect(container.textContent).toContain('Saving a read-only copy…')
    expect(container.textContent).not.toContain('Fix the build')
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

  it('SLEEP-IN-PROGRESS: never shows "nothing was saved" lines while the copy is still being saved', () => {
    // The sleep call returned (no goingToSleep) but the copy has not been read back yet.
    const { container, rerender, props } = view({
      snapshot: { ...snapshot, capturedAt: null, chats: [], terminals: [], git: null },
      viewOnly: true,
      copySave: 'saving'
    })
    expect(container.querySelector('[data-cloud-sleep-copy="saving"]')).not.toBeNull()
    expect(container.textContent).toContain('Going to sleep · Saving a read-only copy…')
    // Not asleep yet as far as the view knows: no "Wake to continue" beside the spinner.
    expect(container.textContent).not.toContain('Wake to continue')
    expect(container.textContent).not.toContain('No terminal output was saved.')
    expect(container.textContent).not.toContain('No source control state was saved.')
    expect(container.textContent).not.toContain('Orca keeps a copy')
    // Saved: the copy (here, its real "no terminal output" line) shows as usual.
    rerender(<CloudWorkspaceOfflineView {...props} snapshot={snapshot} copySave={null} />)
    expect(container.querySelector('[data-cloud-sleep-copy]')).toBeNull()
    expect(container.textContent).toContain('Read-only copy saved when it went to sleep.')
  })

  it('SLEEP-IN-PROGRESS: says so when the copy never arrived; the header Wake is the only Wake', () => {
    const { container, getAllByRole, props } = view({
      snapshot: { ...snapshot, capturedAt: null, chats: [] },
      viewOnly: true,
      copySave: 'failed'
    })
    expect(container.textContent).toContain(
      'Couldn’t save a read-only copy. Your files are safe in the workspace.'
    )
    expect(container.textContent).not.toContain('Orca keeps a copy')
    expect(container.textContent).toContain('Asleep · no read-only copy')
    const wakes = getAllByRole('button', { name: /Wake/ })
    expect(wakes.map((button) => button.textContent)).toEqual(['Wake to continue'])
    fireEvent.click(wakes[0]!)
    expect(props.onWake).toHaveBeenCalledTimes(1)
  })
})
