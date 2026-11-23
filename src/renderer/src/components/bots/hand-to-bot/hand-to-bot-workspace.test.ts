import { describe, expect, it, vi } from 'vitest'
import { handOverWorkspace } from './hand-to-bot-workspace'

describe('handOverWorkspace', () => {
  it('puts the workspace back when the bot refuses it', async () => {
    const restore = vi.fn(async () => {})
    const outcome = await handOverWorkspace({
      move: async () => {},
      notify: async () => {
        throw new Error('Chat is busy.')
      },
      restore
    })
    expect(restore).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({
      ok: false,
      stage: 'notify',
      error: new Error('Chat is busy.'),
      placement: 'restored'
    })
  })

  it('says so when the workspace could not go back', async () => {
    const outcome = await handOverWorkspace({
      move: async () => {},
      notify: async () => {
        throw new Error('refused')
      },
      restore: async () => {
        throw new Error('offline')
      }
    })
    expect(outcome).toMatchObject({ ok: false, stage: 'notify', placement: 'left' })
  })

  it('leaves a workspace the owner moved meanwhile where they put it', async () => {
    const outcome = await handOverWorkspace({
      move: async () => {},
      notify: async () => {
        throw new Error('refused')
      },
      // The owning store's conditional write refused: the parent is no longer the bot's home.
      restore: async () => {
        throw new Error(
          "Error invoking remote method 'worktrees:updateLineage': Error: lineage_parent_changed: the workspace was moved since."
        )
      }
    })
    expect(outcome).toMatchObject({ ok: false, stage: 'notify', placement: 'moved-since' })
  })

  it('tells no bot when the move fails', async () => {
    const notify = vi.fn(async () => 'chat')
    const outcome = await handOverWorkspace({
      move: async () => {
        throw new Error('no folder parent')
      },
      notify,
      restore: async () => {}
    })
    expect(notify).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ ok: false, stage: 'move' })
  })
})
