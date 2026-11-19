import { describe, expect, it } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import { botsAnsweringThere } from './connector-sign-out-confirm'

const bot = (fields: Partial<Bot>): Bot => ({
  id: 'b',
  name: 'B',
  hostId: 'local',
  folder: 'b',
  folderWorkspaceId: 'fw',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1,
  ...fields
})

describe('botsAnsweringThere', () => {
  const acme = { workspaceId: 'org-1', workspaceName: 'Acme' }
  const bots = [
    bot({ name: 'InAcme', linearWorkspaces: [acme] }),
    // The single-workspace field older bots carry.
    bot({ name: 'OldAcme', linear: acme }),
    bot({ name: 'Paused', linearWorkspaces: [acme], github: {}, paused: true }),
    bot({ name: 'OnGitHub', github: {} }),
    bot({ name: 'Nowhere' })
  ]
  const names = (found: readonly Bot[]): string[] => found.map((entry) => entry.name)

  it('counts bots on for the workspace or GitHub, and never paused ones', () => {
    expect(
      names(
        botsAnsweringThere(bots, { source: 'linear', workspaceId: 'org-1', workspaceName: 'Acme' })
      )
    ).toEqual(['InAcme', 'OldAcme'])
    expect(
      names(
        botsAnsweringThere(bots, { source: 'linear', workspaceId: 'org-2', workspaceName: 'Beta' })
      )
    ).toEqual([])
    expect(names(botsAnsweringThere(bots, { source: 'github', login: 'dana' }))).toEqual([
      'OnGitHub'
    ])
  })
})
