import { describe, expect, it } from 'vitest'
import { toSshExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { HiddenProjects } from '../../../../../../shared/project/catalog/hidden-projects'
import { mainWt, repo } from '../parity/sidebar-list-golden-factories.test-fixture'
import { withProjectChatRows } from './project-chat-rows'

const box = toSshExecutionHostId('box')
const alpha = repo('alpha', 'alpha')
// The same project registered on another host under its own repo id.
const alphaOnBuild = repo('alpha-build', 'alpha', {
  executionHostId: toSshExecutionHostId('build')
})
const localMain = mainWt(alpha)
const boxMain = mainWt(alpha, { hostId: box })
const buildMain = mainWt(alphaOnBuild, { hostId: toSshExecutionHostId('build') })

// An all-hosts header whose rows are all hidden: no hostId, no hostRepos, nothing below it.
function chatSources(isRowHidden: HiddenProjects['isRowHidden']): string[] {
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
      worktreesByRepo: { alpha: [localMain, boxMain], 'alpha-build': [buildMain] },
      isRowHidden,
      sectionRepoIds: new Map([['repo:alpha', new Set(['alpha', 'alpha-build'])]])
    },
    new Set([localMain.id, buildMain.id])
  )
  const chats = rows.find((row) => row.type === 'project-chats' && row.section === 'chats')
  return chats?.type === 'project-chats' && chats.section === 'chats'
    ? (chats.chatSources ?? []).map((home) => `${home.repoId}@${home.hostId ?? 'local'}`)
    : []
}

describe('withProjectChatRows', () => {
  it("lists every host's hidden main checkout under an all-hosts header, across repo ids", () => {
    expect(chatSources(() => false)).toEqual([
      'alpha@local',
      `alpha@${box}`,
      `alpha-build@${toSshExecutionHostId('build')}`
    ])
  })

  it('skips a host copy whose project is hidden', () => {
    expect(chatSources((row) => row.hostId === box)).toEqual([
      'alpha@local',
      `alpha-build@${toSshExecutionHostId('build')}`
    ])
  })
})
