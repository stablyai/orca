import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RawItem } from '../../src/main/github/project-view/project-view-item-normalization'
import '../../src/main/github/project-view/project-view-item-page'
import { fetchAllItems } from '../../src/main/github/project-view/project-view-items'
import { _resetProjectViewCachesForTests } from '../../src/main/github/project-view/project-view-cache'
import { ghExecFileAsync } from '../../src/main/git/command-runner/hosted-cli/gh-exec-file'

vi.mock('../../src/main/github/execution/github-operation-slots', () => ({
  acquire: vi.fn(),
  release: vi.fn()
}))

vi.mock('../../src/main/git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: vi.fn()
}))

vi.mock('../../src/main/github/project-view/project-host-execution', () => ({
  projectHostAuthenticationError: vi.fn().mockResolvedValue(null),
  projectGhExecOptions: (host?: string) => ({ host })
}))

vi.mock('../../src/main/github/api/rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  noteRepositoryRateLimitSpend: vi.fn()
}))
vi.mock('../../src/main/github/project-view/project-view-config', () => ({
  ownerQueryRoot: () => 'organization'
}))

const parent = { number: 10, title: 'Parent', url: 'https://github.com/o/r/issues/10' }
const item: RawItem = {
  id: 'item-1',
  type: 'ISSUE',
  content: {
    __typename: 'Issue',
    number: 42,
    title: 'Issue',
    parent,
    subIssuesSummary: { completed: 1, total: 2, percentCompleted: 50 }
  },
  fieldValues: {
    nodes: [
      {
        __typename: 'ProjectV2ItemFieldPullRequestValue',
        field: { id: 'field-pr', name: 'Linked pull requests', dataType: 'LINKED_PULL_REQUESTS' },
        pullRequests: {
          totalCount: 12,
          nodes: Array.from({ length: 10 }, (_, index) => ({
            number: index + 1,
            title: `Change ${index + 1}`,
            url: `https://github.com/o/r/pull/${index + 1}`
          }))
        }
      }
    ]
  }
}
const args = {
  owner: 'o',
  ownerType: 'organization',
  projectNumber: 1,
  query: '',
  host: 'acme.ghe.com'
} as const
const missingSummary = {
  extensions: { code: 'undefinedField', typeName: 'Issue', fieldName: 'subIssuesSummary' },
  message: "Field 'subIssuesSummary' doesn't exist on type 'Issue'"
}

function response(
  nodes: RawItem[],
  totalCount = nodes.length,
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
    hasNextPage: false,
    endCursor: null
  }
) {
  return {
    stdout: JSON.stringify({
      data: {
        organization: {
          projectV2: {
            items: {
              totalCount,
              pageInfo,
              nodes
            }
          }
        }
      }
    }),
    stderr: ''
  }
}
function selectedResponse(arguments_: string[]) {
  const query = arguments_.join(' ')
  const content = { ...item.content }
  if (!query.includes('parent {')) {
    delete content.parent
  }
  if (!query.includes('subIssuesSummary {')) {
    delete content.subIssuesSummary
  }
  return response([
    {
      ...item,
      content,
      fieldValues: query.includes('... on ProjectV2ItemFieldPullRequestValue')
        ? item.fieldValues
        : { nodes: [] }
    }
  ])
}
beforeEach(() => {
  vi.clearAllMocks()
  _resetProjectViewCachesForTests()
  vi.mocked(ghExecFileAsync)
    .mockReset()
    .mockImplementation(async (arguments_) => selectedResponse(arguments_))
})

describe('Project columns from the items response', () => {
  it('keeps supported fields and the cursor on pages after a capability retry', async () => {
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify({ errors: [missingSummary] }),
      stderr: ''
    })
    const firstPage = JSON.parse(
      selectedResponse(['parent {', '... on ProjectV2ItemFieldPullRequestValue']).stdout
    )
    firstPage.data.organization.projectV2.items.pageInfo = { hasNextPage: true, endCursor: 'next' }
    firstPage.data.organization.projectV2.items.totalCount = 2
    vi.mocked(ghExecFileAsync).mockResolvedValueOnce({
      stdout: JSON.stringify(firstPage),
      stderr: ''
    })
    expect(await fetchAllItems(args)).toMatchObject({
      ok: true,
      rows: [expect.objectContaining({ position: 0 }), expect.objectContaining({ position: 1 })]
    })
  })
})
