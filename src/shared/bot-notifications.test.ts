import { describe, expect, it } from 'vitest'
import { isBotAttentionSilenced } from './bot-notifications'

const ALL_ON = { needsPermission: true, taskComplete: true, couldNotFinish: true }

describe('isBotAttentionSilenced', () => {
  it.each(['needsPermission', 'taskComplete', 'couldNotFinish'] as const)(
    'each switch gates only its own news: %s',
    (off) => {
      const bots = [{ folderWorkspaceId: 'fw-1', notifications: { ...ALL_ON, [off]: false } }]
      const news = {
        needsPermission: { agentState: 'blocked' },
        taskComplete: { agentState: 'done', outcome: 'success' },
        couldNotFinish: { agentState: 'done', outcome: 'failure' }
      } as const
      for (const [toggle, item] of Object.entries(news)) {
        expect(isBotAttentionSilenced(bots, 'folder:fw-1', item)).toBe(toggle === off)
      }
    }
  )

  it('leaves workspaces that are no bot’s home alone', () => {
    const bots = [
      {
        folderWorkspaceId: 'fw-1',
        notifications: { needsPermission: false, taskComplete: false, couldNotFinish: false }
      }
    ]
    expect(isBotAttentionSilenced(bots, 'folder:fw-2', { agentState: 'blocked' })).toBe(false)
  })
})
