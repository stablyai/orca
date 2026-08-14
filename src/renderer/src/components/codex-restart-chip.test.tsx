// @vitest-environment happy-dom

import React, { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import CodexRestartChip from './CodexRestartChip'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PTY_ONE = 'worktree-1@@pty-1'
const PTY_TWO = 'worktree-1@@pty-2'

let container: HTMLDivElement
let forgetStalePanes: ReturnType<typeof vi.fn>
let root: Root

function notice(previousAccountLabel: string, nextAccountLabel: string) {
  return { previousAccountLabel, nextAccountLabel }
}

function button(scope: ParentNode, label: string): HTMLButtonElement {
  const match = Array.from(scope.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  forgetStalePanes = vi.fn(() => Promise.resolve())
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { codexAccounts: { forgetStalePanes } }
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('CodexRestartChip pane ownership', () => {
  it('renders the notice owned by its exact PTY', async () => {
    useAppStore.setState({
      codexRestartNoticeByPtyId: {
        [PTY_ONE]: notice('old-one@example.com', 'new-one@example.com'),
        [PTY_TWO]: notice('old-two@example.com', 'new-two@example.com')
      }
    })

    await act(async () => {
      root.render(<CodexRestartChip ptyId={PTY_TWO} />)
    })

    expect(container.textContent).toContain('Codex is still signed in as old-two@example.com')
    expect(container.textContent).toContain('Restart this session to use new-two@example.com')
    expect(container.textContent).not.toContain('old-one@example.com')
  })

  it('uses configuration wording for a home-route restart', async () => {
    useAppStore.setState({
      codexRestartNoticeByPtyId: {
        [PTY_ONE]: {
          previousAccountLabel: 'System default',
          nextAccountLabel: 'System default',
          previousAccountId: null,
          nextAccountId: null,
          homeRouteChanged: true
        }
      }
    })

    await act(async () => {
      root.render(<CodexRestartChip ptyId={PTY_ONE} />)
    })

    expect(container.textContent).toContain('Codex setup changed')
    expect(container.textContent).toContain('This Codex session is using an outdated configuration')
    expect(container.textContent).toContain(
      'Restart this session to load your current Codex configuration.'
    )
  })

  it('restarts only the pane whose action was clicked', async () => {
    useAppStore.setState({
      codexRestartNoticeByPtyId: {
        [PTY_ONE]: notice('old-one@example.com', 'new-one@example.com'),
        [PTY_TWO]: notice('old-two@example.com', 'new-two@example.com')
      }
    })

    await act(async () => {
      root.render(
        <>
          <section data-pane="one">
            <CodexRestartChip ptyId={PTY_ONE} />
          </section>
          <section data-pane="two">
            <CodexRestartChip ptyId={PTY_TWO} />
          </section>
        </>
      )
    })
    const firstPane = container.querySelector('[data-pane="one"]')!
    const secondPane = container.querySelector('[data-pane="two"]')!

    await act(async () => {
      button(firstPane, 'Restart').click()
    })

    const state = useAppStore.getState()
    expect(state.pendingCodexPaneRestartIds).toEqual({ [PTY_ONE]: true })
    expect(state.codexRestartNoticeByPtyId[PTY_ONE]?.restartRequested).toBe(true)
    expect(state.codexRestartNoticeByPtyId[PTY_TWO]).toEqual(
      notice('old-two@example.com', 'new-two@example.com')
    )
    expect(firstPane.textContent).toBe('')
    expect(secondPane.textContent).toContain('old-two@example.com')
  })

  it('dismisses and forgets only the pane whose action was clicked', async () => {
    useAppStore.setState({
      codexRestartNoticeByPtyId: {
        [PTY_ONE]: notice('old-one@example.com', 'new-one@example.com'),
        [PTY_TWO]: notice('old-two@example.com', 'new-two@example.com')
      }
    })

    await act(async () => {
      root.render(
        <>
          <section data-pane="one">
            <CodexRestartChip ptyId={PTY_ONE} />
          </section>
          <section data-pane="two">
            <CodexRestartChip ptyId={PTY_TWO} />
          </section>
        </>
      )
    })
    const firstPane = container.querySelector('[data-pane="one"]')!
    const secondPane = container.querySelector('[data-pane="two"]')!

    await act(async () => {
      button(firstPane, 'Keep old account').click()
    })

    expect(forgetStalePanes).toHaveBeenCalledExactlyOnceWith({ ptyIds: [PTY_ONE] })
    expect(useAppStore.getState().codexRestartNoticeByPtyId[PTY_ONE]?.dismissed).toBe(true)
    expect(useAppStore.getState().codexRestartNoticeByPtyId[PTY_TWO]?.dismissed).toBeUndefined()
    expect(firstPane.textContent).toBe('')
    expect(secondPane.textContent).toContain('old-two@example.com')
  })

  it('follows a pane replacement id without acting on the retired PTY', async () => {
    useAppStore.setState({
      codexRestartNoticeByPtyId: {
        [PTY_ONE]: notice('retired@example.com', 'target@example.com')
      }
    })
    await act(async () => {
      root.render(<CodexRestartChip ptyId={PTY_ONE} />)
    })

    await act(async () => {
      useAppStore.setState({
        codexRestartNoticeByPtyId: {
          [PTY_TWO]: notice('replacement@example.com', 'target@example.com')
        }
      })
      root.render(<CodexRestartChip ptyId={PTY_TWO} />)
    })
    await act(async () => {
      button(container, 'Restart').click()
    })

    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({ [PTY_TWO]: true })
    expect(useAppStore.getState().pendingCodexPaneRestartIds[PTY_ONE]).toBeUndefined()
  })

  it('stays hidden after this pane answers while a sibling remains unanswered', async () => {
    useAppStore.setState({
      codexRestartNoticeByPtyId: {
        [PTY_ONE]: { ...notice('a', 'b'), restartRequested: true },
        [PTY_TWO]: notice('c', 'd')
      }
    })

    await act(async () => {
      root.render(<CodexRestartChip ptyId={PTY_ONE} />)
    })

    expect(container.textContent).toBe('')
  })

  it('does not re-render for unrelated PTY and notice churn', async () => {
    const onRender = vi.fn()
    const ownedNotice = notice('a', 'b')
    useAppStore.setState({ codexRestartNoticeByPtyId: { [PTY_ONE]: ownedNotice } })
    await act(async () => {
      root.render(
        <Profiler id="chip" onRender={onRender}>
          <CodexRestartChip ptyId={PTY_ONE} />
        </Profiler>
      )
    })
    const commits = onRender.mock.calls.length

    await act(async () => {
      useAppStore.setState({
        ptyIdsByTabId: { unrelated: [PTY_TWO] },
        codexRestartNoticeByPtyId: {
          [PTY_ONE]: ownedNotice,
          [PTY_TWO]: notice('c', 'd')
        }
      })
    })

    expect(onRender).toHaveBeenCalledTimes(commits)
  })

  it('does not mutate restart state during a StrictMode replay', async () => {
    useAppStore.setState({
      codexRestartNoticeByPtyId: { [PTY_ONE]: notice('old@example.com', 'new@example.com') }
    })

    await act(async () => {
      root.render(
        <React.StrictMode>
          <CodexRestartChip ptyId={PTY_ONE} shouldFocus />
        </React.StrictMode>
      )
    })

    expect(useAppStore.getState().pendingCodexPaneRestartIds).toEqual({})
    expect(useAppStore.getState().codexRestartNoticeByPtyId[PTY_ONE]).toEqual(
      notice('old@example.com', 'new@example.com')
    )
  })
})

describe('CodexRestartChip pane focus', () => {
  async function renderPane(shouldFocus: boolean, isVisible = true): Promise<HTMLTextAreaElement> {
    await act(async () => {
      root.render(
        <div data-pane="stale">
          <textarea className="xterm-helper-textarea" />
          <CodexRestartChip isVisible={isVisible} ptyId={PTY_ONE} shouldFocus={shouldFocus} />
        </div>
      )
    })
    const terminalInput = container.querySelector('textarea')!
    terminalInput.focus()
    await act(async () => {
      useAppStore.getState().markCodexRestartNotices([
        {
          ptyId: PTY_ONE,
          previousAccountLabel: 'old@example.com',
          nextAccountLabel: 'new@example.com'
        }
      ])
    })
    return terminalInput
  }

  it('focuses the dialog itself for the active stale pane', async () => {
    const terminalInput = await renderPane(true)

    expect(document.activeElement).not.toBe(terminalInput)
    expect(document.activeElement).toBe(container.querySelector('[role="dialog"]'))
    expect(document.activeElement).not.toBe(button(container, 'Restart'))
  })

  it('preserves focus when this stale pane is inactive', async () => {
    const terminalInput = await renderPane(false)

    expect(document.activeElement).toBe(terminalInput)
  })

  it('preserves focus while this pane is hidden', async () => {
    const terminalInput = await renderPane(true, false)

    expect(document.activeElement).toBe(terminalInput)
  })
})
