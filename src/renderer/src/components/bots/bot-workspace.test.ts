import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { makeTestBot } from '../../../../main/bots/bot.test-fixture'
import { findBotByWorkspace } from './bot-workspace'

function hosted(hostId: string): Bot {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the catalog stamps a paired server's bots with that host the same way.
  return { ...makeTestBot({ id: hostId, folderWorkspaceId: 'shared-home' }), hostId } as Bot
}

describe('the bot behind a page', () => {
  it("names each host's own bot when two hosts use the same workspace id", () => {
    const bots = [hosted('local'), hosted('runtime:server')]
    expect(findBotByWorkspace(bots, 'folder:shared-home', 'runtime:server')?.id).toBe(
      'runtime:server'
    )
    expect(findBotByWorkspace(bots, 'folder:shared-home', 'local')?.id).toBe('local')
  })
})
