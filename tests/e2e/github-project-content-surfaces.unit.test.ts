import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { GitHubProjectRow } from '../../src/shared/github/project-types'
import { projectRelationsTableFixture } from '../../src/shared/github/project-relations.test-fixture'
import { normalizeLinkedPullRequests } from '../../src/main/github/project-view/project-view-field-normalization'

vi.mock('../../mobile/src/tasks/mobile-tasks-dependencies', () => ({
  View: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  Text: ({ children }: React.PropsWithChildren) => React.createElement('span', null, children),
  Pressable: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  FlatList: ({
    data,
    renderItem
  }: {
    data: { row: GitHubProjectRow }[]
    renderItem: (args: { item: unknown }) => React.ReactNode
  }) =>
    React.createElement(
      'div',
      null,
      data.map((item) => React.createElement('div', { key: item.row.id }, renderItem({ item })))
    ),
  colors: {},
  spacing: {},
  ChevronDown: () => null,
  TaskProviderLogo: () => null
}))
vi.mock('lucide-react-native', () => ({ Inbox: () => null }))
vi.mock('../../mobile/src/components/MobileStateView', () => ({
  MobileLoadErrorState: () => null,
  MobileNoMatchState: () => null,
  MobileStateView: () => null
}))
vi.mock('../../mobile/src/tasks/mobile-tasks-search-control', () => ({
  clearMobileTasksSearch: () => {}
}))
vi.mock('../../mobile/src/tasks/mobile-tasks-legacy-styles', () => ({ styles: {} }))
vi.mock('../../mobile/src/theme/mobile-theme', () => ({ pressedStyle: {} }))
vi.mock('../../mobile/src/tasks/mobile-tasks-legacy-foundation', async () => {
  const fields = await import('../../mobile/src/tasks/mobile-tasks-project-fields')
  return {
    projectFieldDisplayLabel: fields.projectFieldDisplayLabel,
    projectGroupMeta: () => '',
    projectRowStatusLabel: () => '',
    formatUpdatedAt: () => '',
    getRepoBadgeColor: () => ''
  }
})
import { renderMobileTasksGitHubProjectList } from '../../mobile/src/tasks/mobile-tasks-github-project-list'
import type { ConnectionPresentationModel } from '../../mobile/src/tasks/use-mobile-tasks-connection-presentation'

function phoneText(table: ReturnType<typeof projectRelationsTableFixture>): string {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only the populated-list fields are read; inert controls never invoke omitted actions.
  const model = {
    activeGitHubProject: table.project,
    githubProjectTable: table,
    githubProjectSummaryFields: table.selectedView.fields.slice(1),
    githubProjectRepoSlugReady: true,
    visibleGitHubProjectRows: table.rows,
    githubProjectListEntries: table.rows.map((row) => ({ type: 'row', row })),
    insets: { bottom: 0 },
    findProjectRowRepo: () => null
  } as unknown as ConnectionPresentationModel
  return renderToStaticMarkup(renderMobileTasksGitHubProjectList(model, 'dark', 0)).replace(
    /<[^>]*>/g,
    ''
  )
}

describe('content-backed project field surfaces', () => {
  it('renders fetched phone summary data and overflow when no numeric PR is available', () => {
    const table = projectRelationsTableFixture()
    const populated = phoneText(table)
    expect(populated).toContain('#12')
    expect(populated).toContain('1/2 (50%)')
    table.rows[0].content.linkedPullRequests = normalizeLinkedPullRequests({
      __typename: 'ProjectV2ItemFieldPullRequestValue',
      pullRequests: { nodes: [null, {}], totalCount: 3 }
    })
    expect(phoneText(table)).toContain('+3')
    delete table.rows[0].content.subIssuesProgress
    delete table.rows[0].content.linkedPullRequests
    const absent = phoneText(table)
    expect(absent).not.toContain('#12')
    expect(absent).not.toContain('1/2 (50%)')
    expect(absent).not.toContain('+3')
  })
})
