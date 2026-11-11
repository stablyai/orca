import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatMarkdown } from '../../markdown/NativeChatMarkdown'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../../../shared/gitlab-types'
import type { JiraIssue, JiraSite } from '../../../../../../shared/jira/jira-types'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { NativeChatLinkPeekContext, type NativeChatLinkPeek } from './native-chat-link-peek-context'

const content = `Pull requests from this work:

- [#48](https://github.com/octo/widgets/pull/48): ENG-801, limit the theme setting to registered themes.
- [!12](https://gitlab.com/acme/platform/-/merge_requests/12): OPS-463, the deploy guard.
- **ENG-778:** moved to In Review. UTF-8 and PHP-74 stay plain text.
- [the review notes](https://github.com/octo/widgets/pull/48) keep their own words.`

const jiraSite: JiraSite = {
  id: 'site-1',
  siteUrl: 'https://acme.atlassian.net',
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  accountId: 'ada'
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture data; lookups read only id and path.
const repo = { id: 'repo-1', path: '/tmp/widgets', displayName: 'widgets' } as Repo

const context: NativeChatLinkPeek = {
  githubRepo: { repo, identityKeys: ['octo/widgets'], referenceRepo: null, borrowed: true },
  webPreviews: null,
  issueKeys: new Map([
    ['ENG', 'https://linear.app/acme/issue/'],
    ['OPS', 'https://acme.atlassian.net/browse/']
  ]),
  linearConnected: true,
  jiraSites: [jiraSite],
  gitLabLookupRepo: repo,
  referenceChips: 'full'
}

const contextByMode: Record<NativeChatLinkPeek['referenceChips'], NativeChatLinkPeek> = {
  full: context,
  compact: { ...context, referenceChips: 'compact' },
  off: { ...context, referenceChips: 'off' }
}

const hourAgo = () => new Date(Date.now() - 3_600_000).toISOString()

const linearIssues: Record<string, Pick<LinearIssue, 'title' | 'state' | 'priority'>> = {
  'ENG-801': {
    title: 'Limit the theme setting to registered themes',
    state: { name: 'In Review', type: 'started', color: '#0f783c' },
    priority: 2
  },
  'ENG-778': {
    title: 'Show a closed label where the Edit link was',
    state: { name: 'In Review', type: 'started', color: '#0f783c' },
    priority: 1
  }
}

function stubApis(): void {
  // The browser bridge builds each namespace on read, so replace whole namespaces to keep the stubs.
  const getLinearIssue: typeof window.api.linear.getIssue = async ({ id }) => {
    const issue = linearIssues[id]
    return issue
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture data; the peek reads only these fields.
        ({
          id,
          identifier: id,
          url: `https://linear.app/acme/issue/${id}`,
          team: { id: 't', name: 'Engineering', key: 'ENG' },
          labels: ['Security'],
          labelIds: [],
          assignee: { id: 'u', displayName: 'Ada Lovelace' },
          updatedAt: hourAgo(),
          ...issue
        } as LinearIssue)
      : null
  }
  window.api.linear = { ...window.api.linear, getIssue: getLinearIssue }

  const getJiraIssue: typeof window.api.jira.getIssue = async ({ key }) =>
    key === 'OPS-463'
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture data; the peek reads only these fields.
        ({
          id: '10463',
          key,
          siteId: jiraSite.id,
          title: 'Block deploys while a migration is running',
          url: `${jiraSite.siteUrl}/browse/${key}`,
          project: { id: 'p', key: 'OPS', name: 'Operations' },
          issueType: { id: 'it', name: 'Task' },
          status: {
            id: 's',
            name: 'In Progress',
            categoryKey: 'indeterminate',
            categoryName: 'In Progress'
          },
          labels: [],
          assignee: { accountId: 'ada', displayName: 'Ada Lovelace' },
          priority: { id: 'pr', name: 'High' },
          updatedAt: hourAgo(),
          createdAt: hourAgo()
        } as JiraIssue)
      : null
  window.api.jira = { ...window.api.jira, getIssue: getJiraIssue }

  window.api.gh.workItemByOwnerRepo = async ({ number }) =>
    number === 48
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture data; the chip and peek read only these fields.
        ({
          id: '48',
          type: 'pr',
          number,
          title: 'Limit the theme to registered themes and reject CSS',
          state: 'open',
          url: 'https://github.com/octo/widgets/pull/48',
          labels: [],
          updatedAt: hourAgo(),
          author: 'ada',
          repoId: repo.id,
          additions: 120,
          deletions: 14
        } as GitHubWorkItem)
      : null

  const workItemByPath: typeof window.api.gl.workItemByPath = async ({ iid }) =>
    iid === 12
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture data; the chip and peek read only these fields.
        ({
          id: '12',
          type: 'mr',
          number: 12,
          title: 'Guard deploys behind the migration lock',
          state: 'merged',
          url: 'https://gitlab.com/acme/platform/-/merge_requests/12',
          labels: [],
          updatedAt: hourAgo(),
          author: 'ada'
        } as Omit<GitLabWorkItem, 'repoId'>)
      : null
  window.api.gl = { ...window.api.gl, workItemByPath }
}

const store = {
  linearStatus: { connected: true, viewer: null },
  jiraStatus: { connected: true, viewer: null, sites: [jiraSite] }
}

function Transcript({ mode = 'full' }: { mode?: NativeChatLinkPeek['referenceChips'] }) {
  return (
    <NativeChatLinkPeekContext.Provider value={contextByMode[mode]}>
      <div className="native-chat-appearance p-6 text-sm text-chat-foreground">
        <NativeChatMarkdown variant="document" content={content} />
      </div>
    </NativeChatLinkPeekContext.Provider>
  )
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 400))

export const chips = defineFixture({
  width: 760,
  store,
  setup: stubApis,
  render: () => <Transcript />,
  interact: settle
})

export const compactChips = defineFixture({
  width: 760,
  store,
  setup: stubApis,
  render: () => <Transcript mode="compact" />
})

export const chipsOff = defineFixture({
  width: 760,
  store,
  setup: stubApis,
  render: () => <Transcript mode="off" />
})

function hoverFixture(prefix: string) {
  return defineFixture({
    width: 760,
    store,
    setup: stubApis,
    render: () => (
      <div className="pt-40">
        <Transcript />
      </div>
    ),
    interact: async (frame) => {
      await settle()
      const link = [...frame.querySelectorAll('a')].find((a) => a.textContent?.startsWith(prefix))
      if (!link) {
        throw new Error(`${prefix} was not linked`)
      }
      link.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, pointerType: 'mouse' }))
      link.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
      await new Promise((resolve) => setTimeout(resolve, 900))
    }
  })
}

export const linearPeek = hoverFixture('ENG-778')
export const jiraPeek = hoverFixture('OPS-463')
export const gitLabPeek = hoverFixture('platform!12')
export const gitHubPeek = hoverFixture('widgets#48')
