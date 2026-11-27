// A bot's settings view with real-shaped data: the root and every subpage in the panel host, the root at page width.
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { withBotConnectorRuntime } from '@/lib/bot-connector-host-calls.test-fixture'
import { botPackageName } from '../../../../../shared/bots/bot-share-status'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { stubBots } from '../../../component-fixtures/fixture-bots'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import type { Bot } from '../../../../../shared/bot-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { Repo } from '../../../../../shared/repository/repo-types'
import {
  type BotSettingsHost,
  type BotSettingsPage,
  setBotSettingsPlace
} from './bot-settings-place'
import { BotSettingsView } from './BotSettingsView'
const now = Date.now()
const HOUR = 60 * 60 * 1000

const builder: Bot = {
  id: 'bot-builder',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'fw-builder',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: false, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: {},
  google: true,
  skillProjects: ['orca', 'website'],
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

const repo = (id: string): Repo => ({
  id,
  path: `/Users/owner/globex/${id}`,
  displayName: id,
  badgeColor: '#737373',
  addedAt: 1
})

const SOUL = '# Bot builder\n\nBuilds and maintains Orca bots for the team.\n\n- Short answers.\n'
const MEMORY =
  '# Memory\n\n- 2026-11-06 Releases go out on Tuesdays\n- 2026-11-01 Times in Eastern\n'
const TOPICS = ['archive', 'bots', 'cloud', 'deploys', 'people', 'releases', 'slack'].map(
  (name) => ({ name: `${name}.md`, isDirectory: false, isSymlink: false })
)

function stub(bot: Bot = builder): void {
  stubBots([bot])
  // Connector accounts answer as unlinked ones do.
  const unlinked = { state: async () => ({ ok: false, error: { code: 'not_linked' } }) }
  for (const api of ['botSlack', 'botLinear', 'botGitHub']) {
    Reflect.set(window.api, api, unlinked)
  }
  const answers: Record<string, (params: Record<string, unknown>) => unknown> = {
    'bots.activity': () => ({
      activity: {
        workers: [],
        inProgress: [],
        completed: [],
        automations: [],
        waits: [],
        upNext: { state: { running: false, seenAt: 0, lastLookedAt: now - HOUR }, items: [] }
      }
    }),
    'bots.tidyUp.get': () => ({
      tidyUp: {
        setting: { on: true, every: 'night' },
        last: {
          at: now - 2 * HOUR,
          tookMs: 90_000,
          chats: 3,
          rowId: null,
          learned: [],
          replaced: [],
          filed: [],
          moved: 2,
          merged: 1,
          undone: false
        },
        running: false,
        turnedOff: null,
        error: null
      }
    }),
    'bots.tools.list': () => ({
      agent: 'claude',
      own: [
        { name: 'sentry', detail: 'npx @sentry/mcp-server', remote: false },
        { name: 'playwright', detail: 'npx @playwright/mcp', remote: false }
      ],
      inherited: ['linear', 'github', 'notion', 'context7', 'local-notes'].map((name) => ({ name }))
    }),
    'bots.tools.problems': () => ({ problems: {} }),
    'bots.skillProjects.scan': (params) => ({
      projects: (Array.isArray(params.repoIds) ? params.repoIds : []).map((id) => ({
        repoId: String(id),
        name: String(id),
        status: 'local',
        skillsDir: `/Users/owner/globex/${String(id)}/.agents/skills`,
        skills: [{ name: 'electron', description: 'Launch and validate Electron apps' }]
      })),
      ...(params.botId
        ? {
            own: {
              skillsDir: '/Users/owner/.orca/bots/release-notes/skills',
              skills: [
                {
                  name: 'release-notes-style',
                  description: 'House style for release notes',
                  folder: '/Users/owner/.orca/bots/release-notes/skills/release-notes-style',
                  loadedBy: ['claude', 'agents']
                }
              ],
              agentOnly: []
            }
          }
        : {})
    }),
    'bots.memory.history': () => ({ rows: [] }),
    'bots.list': () => ({ bots: [bot] }),
    'bots.share.status': () => ({ status: 'ok', value: [] }),
    'bots.groups.list': () => ({ groups: [] })
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
  withBotConnectorRuntime(window.api)
  Reflect.set(window.api, 'fs', {
    ...window.api.fs,
    readFile: async ({ filePath }: { filePath: string }) => ({
      content: filePath.endsWith('SOUL.md') ? SOUL : MEMORY,
      isBinary: false
    }),
    readDir: async () => TOPICS
  })
}

function View({ host, bot }: { host: BotSettingsHost; bot: Bot }): React.JSX.Element {
  return (
    <ConfirmationDialogProvider>
      {host === 'panel' ? (
        <div className="flex h-[900px] flex-col bg-sidebar">
          <BotSettingsView bot={bot} host="panel" onExit={() => {}} onDeleted={() => {}} />
        </div>
      ) : (
        <div className="settings-view-shell bg-background px-8 pt-6 pb-12">
          <BotSettingsView bot={bot} host="page" onExit={() => {}} onDeleted={() => {}} />
        </div>
      )}
    </ConfirmationDialogProvider>
  )
}

const store = {
  repos: [repo('orca'), repo('website')],
  folderWorkspaces: [
    makeFolderWorkspace({
      id: 'fw-builder',
      name: 'Bot builder',
      folderPath: '/Users/owner/.orca/bots/bot-builder'
    })
  ]
}

function at(
  host: BotSettingsHost,
  page: BotSettingsPage | null,
  width = 380,
  bot: Bot = builder,
  more?: () => void
) {
  return defineFixture({
    width,
    store,
    setup: () => {
      stub(bot)
      more?.()
      setBotSettingsPlace(host, { botId: bot.id, page })
    },
    render: () => <View host={host} bot={bot} />
  })
}

// On Linear in Acme with two people, one asking: Linear's whole list on the Who can ask page.
const withPeople: Bot = {
  ...builder,
  linear: { workspaceId: 'org-1', workspaceName: 'Acme' },
  members: [
    { id: 'L-bea', name: 'Bea Ortiz', source: 'linear', workspaceId: 'org-1' },
    { id: 'L-jo', name: 'Jo Park', source: 'linear', workspaceId: 'org-1' }
  ]
}

function linkedLinear(): void {
  Reflect.set(window.api, 'botLinear', {
    state: async () => ({
      ok: true,
      value: {
        workspaces: [
          {
            workspaceId: 'org-1',
            name: 'Acme',
            urlKey: 'acme',
            installed: true,
            userId: 'L-me',
            userName: 'Dana',
            defaultBotId: null
          }
        ],
        installUrl: 'https://connector.example/linear/install'
      }
    })
  })
}

export const root = at('panel', null)
export const rootNarrow = at('panel', null, 260)
export const rootPage = at('page', null, 900)
export const agent = at('panel', 'agent')
export const permissions = at('panel', 'permissions')
export const computer = at('panel', 'computer')
export const lookAround = at('panel', 'look-around')
export const tidyUp = at('panel', 'tidy-up')
export const soul = at('panel', 'soul')
export const memory = at('panel', 'memory')
export const connectors = at('panel', 'connectors')
export const whoCanAsk = at('panel', 'who-can-ask')
export const tools = at('panel', 'tools')
// The tools it gets from its agent, open: each with its brand's logo where one is known.
export const toolsInherited = {
  ...tools,
  interact: async (frame: HTMLElement) => {
    await new Promise((resolve) => setTimeout(resolve, 150))
    Array.from(frame.querySelectorAll<HTMLButtonElement>('button[aria-expanded="false"]'))
      .at(-1)
      ?.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}
export const skills = at('panel', 'skills')
export const sharing = at('panel', 'sharing')
export const sharingNarrow = at('panel', 'sharing', 260)

/** The bot's live link, as Orca Cloud lists it. */
function sharedLink(): void {
  const runtime = window.api.runtime
  Reflect.set(window.api, 'runtime', {
    ...runtime,
    call: async (request: { method: string; params: Record<string, unknown> }) =>
      request.method === 'bots.share.status'
        ? {
            ok: true,
            result: {
              status: 'ok',
              value: [
                {
                  id: 'k7Qm2xR9vTb4',
                  url: 'https://app.onorca.dev/bots/share/k7Qm2xR9vTb4',
                  packageId: 'package-1',
                  name: botPackageName(builder.id),
                  createdAt: '2026-10-30T15:00:00.000Z',
                  canonical: true,
                  pinnedVersionId: 'v2',
                  pinnedPublishedAt: '2026-11-09T20:12:00.000Z',
                  pinnedDigest: 'digest'
                }
              ]
            }
          }
        : runtime.call(request)
  })
}
export const sharingShared = at('panel', 'sharing', 380, builder, sharedLink)
export const rootShared = at('panel', null, 380, builder, sharedLink)
export const memoryPage = at('page', 'memory', 900)
export const whoCanAskEmpty = at('panel', 'who-can-ask', 380, {
  ...builder,
  slack: null,
  linear: null,
  github: null
})
export const whoCanAskPeople = at('panel', 'who-can-ask', 380, withPeople, linkedLinear)

// Made from Dara's link: who shared it and when, with its original a click away.
const fromLink: Bot = {
  ...builder,
  sharedFrom: {
    shareId: 'k7Qm2xR9vTb4',
    packageId: 'package-1',
    versionId: 'version-1',
    sharedBy: 'Dara Okafor',
    sharedAt: '2026-11-08T15:00:00.000Z'
  }
}
export const rootFromLink = at('panel', null, 380, fromLink)
export const rootFromLinkNarrow = at('panel', null, 260, fromLink)
// A long sharer name: it truncates, and View original stays whole.
export const rootFromLinkLongName = at('panel', null, 260, {
  ...fromLink,
  sharedFrom: fromLink.sharedFrom && {
    ...fromLink.sharedFrom,
    sharedBy: 'Alexandria Catherine Montgomery-Whitfield'
  }
})

// The fixture frame adds 16px padding on each side of the panel.
export const density280 = at('panel', null, 280 + 32)
export const density353 = at('panel', null, 353 + 32)
export const density480 = at('panel', null, 480 + 32)
export const density240 = at('panel', null, 240 + 32)

const studio: PublicKnownRuntimeEnvironment = {
  id: 'studio',
  name: 'Design studio Mac mini in the back office',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [],
  preferredEndpointId: 'studio'
}

// Long values at the narrowest panel: a long bot name, server name, people list and project list.
export const longValues240 = defineFixture({
  ...at(
    'panel',
    null,
    240 + 32,
    stampBotHost('runtime:studio', {
      ...withPeople,
      name: 'Release notes and changelog builder'
    }),
    () => {
      linkedLinear()
      // The studio server answers as this computer's runtime does.
      Reflect.set(window.api, 'runtimeEnvironments', {
        ...window.api.runtimeEnvironments,
        call: async (request: { method: string; params: Record<string, unknown> }) =>
          request.method === 'status.get'
            ? { ok: true, result: createCompatibleRuntimeStatusResponse('studio').result }
            : window.api.runtime.call(request)
      })
    }
  ),
  store: { ...store, runtimeEnvironments: [studio] }
})

function HeaderWithDuplicate(): React.JSX.Element {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const actions = frame?.querySelector('[data-slot="bot-settings-actions"]')
  return (
    <div ref={setFrame}>
      {density280.render()}
      {actions &&
        createPortal(
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="muted-field-icon"
                size="icon-sm"
                className="size-7"
                aria-label="Duplicate"
              >
                <Copy className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Duplicate</TooltipContent>
          </Tooltip>,
          actions
        )}
    </div>
  )
}

export const density280WithDuplicate = defineFixture({
  ...density280,
  render: () => <HeaderWithDuplicate />
})

/** Share's tooltip, on hover. */
export const shareTooltip = defineFixture({
  ...density280,
  interact: async (frame) => {
    await new Promise((resolve) => setTimeout(resolve, 150))
    frame
      .querySelector('[data-slot="bot-settings-actions"] button')
      ?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
})
