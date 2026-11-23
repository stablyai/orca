import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { findBotByWorkspace } from './bot-workspace'

function bot(id: string, hostId: string): Bot {
  return { id, name: id, hostId, folderWorkspaceId: 'home-1' } as unknown as Bot
}

describe('findBotByWorkspace', () => {
  it('names only the bot on the given host when two hosts reuse a workspace id', () => {
    const bots = [bot('Local bot', 'local'), bot('Server bot', 'runtime:server-1')]
    expect(findBotByWorkspace(bots, 'folder:home-1', 'runtime:server-1')?.name).toBe('Server bot')
    expect(findBotByWorkspace(bots, 'folder:home-1', 'local')?.name).toBe('Local bot')
    expect(findBotByWorkspace(bots, 'folder:home-1', 'runtime:server-2')).toBeNull()
    expect(findBotByWorkspace(bots, 'folder:other', 'local')).toBeNull()
  })
})
