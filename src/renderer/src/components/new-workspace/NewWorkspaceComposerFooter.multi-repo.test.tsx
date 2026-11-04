// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NewWorkspaceComposerFooter } from './NewWorkspaceComposerFooter'
import type { MultiRepoComposerView } from './use-multi-repo-composer'

vi.mock('@/components/ButtonKeyHint', () => ({ ButtonKeyHint: () => null }))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

function multi(patch: Partial<MultiRepoComposerView>): MultiRepoComposerView {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the footer reads only these fields; the hook's other outputs are not rendered here.
  return {
    active: true,
    creating: false,
    createError: null,
    mixedHostsError: false,
    blockedReason: null,
    ...patch
  } as MultiRepoComposerView
}

function render(
  multiRepo: MultiRepoComposerView,
  extra: { composerRef?: React.RefObject<HTMLDivElement | null>; createDisabled?: boolean } = {}
): void {
  act(() => {
    root.render(
      <NewWorkspaceComposerFooter
        createError={null}
        showCreateMultiple
        createMultiple={false}
        onCreate={vi.fn()}
        createDisabled={extra.createDisabled ?? false}
        creating={false}
        primaryActionLabel="Create in 3 projects"
        multiRepo={multiRepo}
        composerRef={extra.composerRef}
        submitShortcutModifierLabel="Cmd"
      />
    )
  })
}

describe('NewWorkspaceComposerFooter in multi-repo mode', () => {
  it('shows the reason beside a blocked Create and hides Create more', () => {
    render(multi({ blockedReason: 'Remove 1 project or switch host' }), { createDisabled: true })
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Remove 1 project or switch host'
    )
    expect(container.querySelector('[role="switch"]')).toBeNull()
    expect(container.querySelector('button[disabled]')).not.toBeNull()
  })

  it('keeps a mixed-hosts error inline with a Choose host action that opens the host picker', () => {
    const composer = document.createElement('div')
    composer.innerHTML =
      '<div data-multi-repo-host-field="true"><button type="button"></button></div>'
    const hostTrigger = composer.querySelector('button')
    const openHostPicker = vi.fn()
    hostTrigger?.addEventListener('click', openHostPicker)
    render(multi({ mixedHostsError: true }), { composerRef: { current: composer } })
    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain(
      'Selected projects span more than one host. Pick a host to continue.'
    )
    const action = Array.from(alert?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Choose host'
    )
    act(() => {
      action?.click()
    })
    expect(openHostPicker).toHaveBeenCalledTimes(1)
  })

  it('shows the multi-repo create error instead of the single-repo one', () => {
    render(multi({ createError: { title: 'Workspace creation failed', message: 'boom' } }))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('boom')
  })
})
