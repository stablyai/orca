// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
import { SubmoduleChangesPanel } from './submodule-changes-panel'
import type { SubmoduleChangesState } from './use-submodule-changes'

afterEach(cleanup)

const STAGED: GitStatusEntry = { path: 'src/staged.ts', status: 'modified', area: 'staged' }
const UNSTAGED: GitStatusEntry = { path: 'plain.txt', status: 'modified', area: 'unstaged' }
const UNTRACKED: GitStatusEntry = { path: 'new.txt', status: 'untracked', area: 'untracked' }
const NESTED: GitStatusEntry = {
  path: 'deeper',
  status: 'modified',
  area: 'unstaged',
  submoduleRoot: 'deeper'
}

function renderPanel(
  state: SubmoduleChangesState | undefined,
  { message = '', busy = false }: { message?: string; busy?: boolean } = {}
) {
  const handlers = {
    onStage: vi.fn(),
    onUnstage: vi.fn(),
    onMessage: vi.fn(),
    onCommit: vi.fn()
  }
  render(
    <TooltipProvider>
      <SubmoduleChangesPanel state={state} message={message} busy={busy} {...handlers} />
    </TooltipProvider>
  )
  return handlers
}

const ready = (...entries: GitStatusEntry[]): SubmoduleChangesState => ({
  status: 'ready',
  entries
})

describe('SubmoduleChangesPanel', () => {
  it('sends the typed message up', () => {
    const { onMessage } = renderPanel(ready(STAGED))
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'hello' }
    })
    expect(onMessage).toHaveBeenCalledWith('hello')
  })

  it('shows loading, error and empty states', () => {
    renderPanel(undefined)
    expect(screen.getByText('Loading changes…')).toBeInTheDocument()
    cleanup()
    renderPanel({ status: 'error', message: 'not a git repository' })
    expect(screen.getByText('not a git repository')).toBeInTheDocument()
    cleanup()
    renderPanel(ready())
    expect(screen.getByText('No changes')).toBeInTheDocument()
  })

  it('groups staged files apart from unstaged and untracked ones', () => {
    renderPanel(ready(STAGED, UNSTAGED, UNTRACKED))
    expect(screen.getByText('Staged')).toBeInTheDocument()
    expect(screen.getByText('Changes')).toBeInTheDocument()
    expect(screen.getAllByTestId('submodule-change-row')).toHaveLength(3)
  })

  it('stages and unstages one file by its button', () => {
    const { onStage, onUnstage } = renderPanel(ready(STAGED, UNSTAGED))
    fireEvent.click(screen.getByRole('button', { name: 'Stage plain.txt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unstage staged.ts' }))
    expect(onStage).toHaveBeenCalledWith(['plain.txt'])
    expect(onUnstage).toHaveBeenCalledWith(['src/staged.ts'])
  })

  it('stages all, but never a nested submodule row it cannot stage', () => {
    const { onStage } = renderPanel(ready(UNSTAGED, UNTRACKED, NESTED))
    fireEvent.click(screen.getByRole('button', { name: 'Stage all' }))
    expect(onStage).toHaveBeenCalledWith(['plain.txt', 'new.txt'])
  })

  it('commits only with staged files and a message', () => {
    const none = renderPanel(ready(UNSTAGED), { message: 'msg' })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(none.onCommit).not.toHaveBeenCalled()
    cleanup()

    const noMessage = renderPanel(ready(STAGED), { message: '   ' })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(noMessage.onCommit).not.toHaveBeenCalled()
    cleanup()

    const ok = renderPanel(ready(STAGED), { message: 'fix it' })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(ok.onCommit).toHaveBeenCalledTimes(1)
  })

  it('blocks every control while an action runs', () => {
    const { onStage, onCommit } = renderPanel(ready(STAGED, UNSTAGED), {
      message: 'msg',
      busy: true
    })
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Stage plain.txt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(onStage).not.toHaveBeenCalled()
    expect(onCommit).not.toHaveBeenCalled()
  })
})
