import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  BotOwnSkillsView,
  BotSkillProjectView
} from '../../../../../shared/bots/bot-skill-projects'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { SettingsSectionStack } from '../section-layout/SettingsSectionStack'
import { BotSkillsSection } from './BotSkillsSection'
import { BotToolsSection } from './BotToolsSection'

const ORCA_SKILLS = [
  ['electron', 'Launch and validate Electron apps over CDP'],
  ['perf', 'Audit slow UI, input lag, high CPU, leaks'],
  ['ref-oss', 'Look at local open-source reference repos'],
  ['orca-rc-release-audit', 'Audit an RC against the last stable release'],
  ['readiness-checklist', 'Exhaustive pre-release readiness review'],
  ...Array.from({ length: 55 }, (_, index) => [`skill-${index}`, 'More'])
].map(([name, description]) => ({ name: name!, description: description! }))

function repo(id: string, extra: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/Users/owner/globex/${id}`,
    displayName: id,
    badgeColor: '#737373',
    addedAt: 1,
    ...extra
  }
}

const REPOS = [
  repo('orca'),
  repo('notes-app'),
  repo('website'),
  repo('api', { connectionId: 'gpu-box' }),
  repo('notes', { kind: 'folder' })
]

/** A template bot's own skill, and one an older version left in Claude's folder. */
const OWN: BotOwnSkillsView = {
  skillsDir: '/Users/owner/.orca/bots/pr-review/skills',
  skills: [
    {
      name: 'pr-review-checklist',
      description: 'What to check on every pull request',
      folder: '/Users/owner/.orca/bots/pr-review/skills/pr-review-checklist',
      loadedBy: ['claude', 'agents']
    }
  ],
  agentOnly: [
    {
      name: 'house-style',
      description: 'Our review tone',
      folder: '/Users/owner/.orca/bots/pr-review/.claude/skills/house-style',
      loadedBy: ['claude']
    }
  ]
}

const VIEWS: Record<string, BotSkillProjectView> = {
  orca: {
    repoId: 'orca',
    name: 'orca',
    status: 'local',
    skillsDir: '/Users/owner/globex/orca/.agents/skills',
    skills: ORCA_SKILLS
  },
  'notes-app': {
    repoId: 'notes-app',
    name: 'notes-app',
    status: 'local',
    skillsDir: '/Users/owner/globex/notes-app/.agents/skills',
    skills: ORCA_SKILLS.slice(0, 12)
  },
  website: { repoId: 'website', name: 'website', status: 'local', skillsDir: null, skills: [] },
  api: {
    repoId: 'api',
    name: 'api',
    status: 'remote',
    skillsDir: null,
    skills: []
  },
  notes: { repoId: 'notes', name: 'notes', status: 'local', skillsDir: null, skills: [] }
}

function atlas(extra: Partial<Bot> = {}): Bot {
  return {
    id: 'atlas',
    name: 'Atlas',
    hostId: 'local',
    folder: 'atlas',
    folderWorkspaceId: 'fw-atlas',
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
    ...extra
  }
}

const HOST_SERVERS = ['linear', 'sentry', 'postgres', 'context7'].map((name, index) => ({
  id: `server-0000000${index}`,
  name,
  detail: `https://mcp.${name}.dev/mcp`,
  transport: 'http',
  remote: false,
  agentsOff: [],
  workspaces: { later: true, on: [], off: [] },
  sharedProcess: false
}))

function stubRuntime(hostMcpServers?: boolean): void {
  const answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    'mcpServers.list': () => ({
      servers: HOST_SERVERS,
      agentFiles: { grok: false, cursor: false, droid: false }
    }),
    'bots.tools.list': () => ({
      ...(hostMcpServers === undefined ? {} : { hostMcpServers }),
      agent: 'claude',
      own: [
        { name: 'sentry', detail: 'https://mcp.sentry.dev/mcp', remote: true },
        { name: 'design', detail: 'https://mcp.figma.com/mcp', remote: true },
        { name: 'local-search', detail: 'npx local-search-mcp', remote: false }
      ],
      inherited: [{ name: 'linear' }, { name: 'notion' }, { name: 'playwright', plugin: true }]
    }),
    'bots.tools.problems': () => ({ problems: {} }),
    'bots.list': () => ({ bots: [] }),
    'bots.skillProjects.scan': (params) => ({
      projects: Array.isArray(params.repoIds) ? params.repoIds.map((id) => VIEWS[String(id)]) : [],
      ...(params.botId ? { own: OWN } : {})
    })
  }
  Reflect.set(window.api, 'runtime', {
    ...window.api.runtime,
    call: async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      const answer = answers[method]
      return answer
        ? { ok: true, result: answer(params) }
        : { ok: false, error: { code: 'runtime_error', message: method } }
    }
  })
}

function Page({ bot, skills }: { bot: Bot; skills: boolean }): React.JSX.Element {
  return (
    <div className="p-6">
      <SettingsSectionStack
        sections={[
          <BotToolsSection key="tools" bot={bot} />,
          skills ? <BotSkillsSection key="skills" bot={bot} onChange={() => {}} /> : null
        ]}
      />
    </div>
  )
}

const linked = atlas({ skillProjects: ['orca', 'api', 'website'] })

export const before = defineFixture({
  width: 720,
  store: { repos: REPOS },
  setup: () => stubRuntime(),
  render: () => <Page bot={linked} skills={false} />
})

/** A host that serves MCP servers: the bot can take them with one switch (d13). */
export const hostMcpServersOn = defineFixture({
  width: 720,
  store: { repos: REPOS },
  setup: () => stubRuntime(true),
  render: () => <Page bot={linked} skills={false} />
})

export const projectsLinked = defineFixture({
  width: 720,
  store: { repos: REPOS },
  setup: () => stubRuntime(),
  render: () => <Page bot={linked} skills />,
  interact: async (frame) => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const rows = Array.from(frame.querySelectorAll<HTMLButtonElement>('button[aria-expanded]'))
    rows.find((button) => button.textContent === 'orca')?.click()
  }
})

export const linkPicker = defineFixture({
  width: 720,
  store: { repos: REPOS },
  setup: () => stubRuntime(),
  render: () => <Page bot={atlas({ skillProjects: ['orca'] })} skills />,
  interact: async (frame) => {
    const link = Array.from(frame.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Link a project'
    )
    link?.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
})

export const listedForGrok = defineFixture({
  width: 720,
  store: { repos: REPOS },
  setup: () => stubRuntime(),
  render: () => <Page bot={atlas({ agent: 'grok', skillProjects: ['orca'] })} skills />
})

export const noneLinked = defineFixture({
  width: 720,
  store: { repos: REPOS },
  setup: () => stubRuntime(),
  render: () => <Page bot={atlas()} skills />
})
