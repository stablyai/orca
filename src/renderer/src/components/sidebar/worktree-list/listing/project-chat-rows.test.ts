import { describe, expect, it } from 'vitest'
import { toSshExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { HiddenProjects } from '../../../../../../shared/project/catalog/hidden-projects'
import { mainWt, repo } from '../parity/sidebar-list-golden-factories.test-fixture'
import { withProjectChatRows } from './project-chat-rows'

const alpha = repo('alpha', 'alpha')
const localMain = mainWt(alpha)
const remoteMain = mainWt(alpha, { hostId: toSshExecutionHostId('box') })

// An all-hosts header whose rows are all hidden: no hostId, no hostRepos, nothing below it.
function chatSources(isRowHidden: HiddenProjects['isRowHidden']): (string | undefined)[] {
  const rows = withProjectChatRows(
    [
      {
        type: 'header',
        key: 'repo:alpha',
        label: 'alpha',
        count: 0,
        icon: { kind: 'project' },
        repo: alpha
      }
    ],
    {
      groupBy: 'repo',
      collapsedGroups: new Set(),
      worktreesByRepo: { alpha: [localMain, remoteMain] },
      isRowHidden
    },
    new Set([localMain.id])
  )
  const chats = rows.find((row) => row.type === 'project-chats' && row.section === 'chats')
  return chats?.type === 'project-chats' && chats.section === 'chats'
    ? (chats.chatSources ?? []).map((home) => home.hostId)
    : []
}

describe('withProjectChatRows', () => {
  it("lists every host's hidden main checkout under an all-hosts header", () => {
    expect(chatSources(() => false)).toEqual([undefined, remoteMain.hostId])
  })

  it('skips a host copy whose project is hidden', () => {
    expect(chatSources((row) => row.hostId === remoteMain.hostId)).toEqual([undefined])
  })
})
