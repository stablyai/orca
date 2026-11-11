import { describe, expect, it, vi } from 'vitest'
import { cloudWokeActionFor, runCloudWokeAction } from './cloud-wake-hint-action'

const pane = { tabId: 'tab-1', leafId: 'leaf-1', worktreeId: 'wt-1' }

describe('the woke-up strip action (JA-15)', () => {
  it('a Claude pane runs the shared agent Restart and types nothing into the pane', () => {
    const sendInput = vi.fn()
    const restart = vi.fn()
    runCloudWokeAction({ restartAgent: 'claude' }, { ...pane, sendInput }, restart)
    expect(restart).toHaveBeenCalledWith({ ...pane, agent: 'claude' })
    expect(sendInput).not.toHaveBeenCalled()
    expect(cloudWokeActionFor({ restartAgent: 'claude' })).toEqual({
      kind: 'restart',
      agent: 'Claude'
    })
  })

  it('a shell pane retypes its own command and never restarts an agent', () => {
    const sendInput = vi.fn()
    const restart = vi.fn()
    runCloudWokeAction({ command: 'pnpm dev' }, { ...pane, sendInput }, restart)
    expect(sendInput).toHaveBeenCalledWith('pnpm dev\r')
    expect(restart).not.toHaveBeenCalled()
    expect(cloudWokeActionFor({ command: 'pnpm dev' })).toEqual({
      kind: 'rerun',
      command: 'pnpm dev'
    })
  })
})
