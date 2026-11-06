import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { projectRelationsTableFixture } from '../../../../shared/github/project-relations.test-fixture'
import { projectRelationCellText } from './ProjectCell.test-fixture'

vi.mock('../../../../../mobile/src/tasks/mobile-tasks-dependencies', () => ({
  View: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Text: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
  Pressable: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  FlatList: ({
    data,
    renderItem
  }: {
    data: unknown[]
    renderItem: (args: { item: unknown }) => React.ReactNode
  }) => (
    <div>
      {data.map((item, index) => (
        <div key={index}>{renderItem({ item })}</div>
      ))}
    </div>
  ),
  colors: {},
  spacing: {},
  ChevronDown: () => null,
  TaskProviderLogo: () => null
}))
vi.mock('lucide-react-native', () => ({ Inbox: () => null }))
vi.mock('../../../../../mobile/src/components/MobileStateView', () => ({
  MobileLoadErrorState: () => null,
  MobileNoMatchState: () => null,
  MobileStateView: () => null
}))
vi.mock('../../../../../mobile/src/tasks/mobile-tasks-search-control', () => ({
  clearMobileTasksSearch: () => {}
}))
vi.mock('../../../../../mobile/src/tasks/mobile-tasks-legacy-styles', () => ({ styles: {} }))
vi.mock('../../../../../mobile/src/theme/mobile-theme', () => ({ pressedStyle: {} }))
vi.mock('../../../../../mobile/src/tasks/mobile-tasks-legacy-foundation', async () => {
  const fields = await import('../../../../../mobile/src/tasks/mobile-tasks-project-fields')
  return {
    projectFieldDisplayLabel: fields.projectFieldDisplayLabel,
    projectGroupMeta: () => '',
    projectRowStatusLabel: () => '',
    formatUpdatedAt: () => '',
    getRepoBadgeColor: () => ''
  }
})
import { renderMobileTasksGitHubProjectList } from '../../../../../mobile/src/tasks/mobile-tasks-github-project-list'
import type { ConnectionPresentationModel } from '../../../../../mobile/src/tasks/use-mobile-tasks-connection-presentation'

function phoneText(table: ReturnType<typeof projectRelationsTableFixture>): string {
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
  it('keeps desktop data and overflow visible through the shared extraction', () => {
    const table = projectRelationsTableFixture()
    expect(projectRelationCellText(table.rows[0])).toEqual(['#12 +2 more', '1/2 (50%)'])
    table.rows[0].content.linkedPullRequests = { pullRequests: [], totalCount: 3 }
    expect(projectRelationCellText(table.rows[0])[0]).toContain('+3')
    expect(projectRelationCellText(table.rows[1])).toEqual(['', ''])
  })

  it('renders fetched phone summary data and overflow when no numeric PR is available', () => {
    const table = projectRelationsTableFixture()
    const populated = phoneText(table)
    expect(populated).toContain('#12')
    expect(populated).toContain('1/2 (50%)')
    table.rows[0].content.linkedPullRequests = { pullRequests: [], totalCount: 3 }
    expect(phoneText(table)).toContain('+3')
    delete table.rows[0].content.subIssuesProgress
    delete table.rows[0].content.linkedPullRequests
    const absent = phoneText(table)
    expect(absent).not.toContain('#12')
    expect(absent).not.toContain('1/2 (50%)')
    expect(absent).not.toContain('+3')
  })
})
