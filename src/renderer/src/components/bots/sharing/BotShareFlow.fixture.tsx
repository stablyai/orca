// Every state of the one Share dialog, against a stubbed runtime: not shared, shared, busy, refused.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotShareCandidateSummary } from '../../../../../shared/bots/bot-package'
import { BOT_SHARE_ERRORS } from '../../../../../shared/bots/bot-share-errors'
import { ORCA_CONNECTED } from '../orca-sign-in.test-fixture'
import { signedOutStore } from '../orca-cloud-sign-in-host-fixture'
import { BotShareFlow } from './BotShareFlow'
import type { BotShareLink } from './use-bot-share-link'

const builder: Bot = {
  id: 'bot-builder',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'fw-builder',
  agent: 'claude',
  avatar: 'mascot:M1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
const longBot: Bot = {
  ...builder,
  id: 'bot-long',
  name: 'Release captain for platform, desktop and mobile trains',
  avatar: null
}

const URL = 'https://app.onorca.dev/bots/share/k7Qm2xR9vTb4'

function candidate(change: Partial<BotShareCandidateSummary> = {}): BotShareCandidateSummary {
  return {
    candidateId: 'c1',
    packageId: 'package-1',
    versionId: 'version-c1',
    botDigest: 'digest-now',
    archiveSha256: 'sha',
    compressedBytes: 1,
    fileCount: 1,
    totalBytes: 1,
    bot: {
      schemaVersion: 1,
      name: 'Bot builder',
      purpose: 'Builds and maintains Orca bots for the team.',
      agentHint: 'claude',
      skills: [{ name: 'orca' }, { name: 'website' }],
      tools: [],
      connectors: [],
      schedules: [],
      eventSuggestions: [],
      memory: []
    },
    files: [],
    leftOut: [],
    notIncluded: [],
    rewritten: [],
    available: {
      soulLines: 19,
      skills: [
        {
          name: 'orca',
          description: 'Drive Orca worktrees, terminals and the browser',
          homePath: 'skills/orca'
        },
        {
          name: 'website',
          description: 'Edit and deploy the marketing site',
          homePath: 'skills/website'
        },
        {
          name: 'release-notes',
          description: 'Draft notes from merged PRs',
          homePath: 'skills/release-notes'
        }
      ],
      schedules: [
        { automationId: 'a1', name: 'Weekly bot digest', rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9' }
      ],
      eventSuggestions: [],
      tools: [
        { name: 'Issues', url: 'https://issues.example.com/mcp' },
        { name: 'Browser', url: 'https://browser.example.com/mcp' }
      ],
      memory: ['MEMORY', 'people', 'release-process', 'repos', 'style', 'tools', 'ideas'].map(
        (topic) => ({ topic, lines: 12 })
      )
    },
    automationIds: { schedules: ['a1'], eventSuggestions: [] },
    flags: [],
    blocked: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...change
  }
}

const never = (): Promise<never> => new Promise(() => {})
const ok = (result: unknown) => ({ ok: true, result })
const refused = (code: string) => ({ ok: false, error: { code: 'runtime_error', message: code } })

type Answers = {
  prepare?: () => Promise<unknown>
  status?: () => Promise<unknown>
  publish?: () => Promise<unknown>
}

function stub(answers: Answers = {}): void {
  const runtime: unknown = window.api.runtime
  Reflect.set(window.api, 'ui', { ...window.api.ui, writeClipboardText: async () => undefined })
  Reflect.set(window.api, 'runtime', {
    ...(typeof runtime === 'object' ? runtime : {}),
    call: async ({ method }: { method: string }) => {
      if (method === 'bots.share.prepare') {
        return answers.prepare ? answers.prepare() : ok({ candidate: candidate() })
      }
      if (method === 'bots.share.status') {
        return answers.status ? answers.status() : ok({ status: 'ok', value: [] })
      }
      if (method === 'bots.share.publish') {
        return answers.publish
          ? answers.publish()
          : ok({
              status: 'ok',
              value: {
                share: { id: 's1', url: URL, pinnedVersionId: 'v2' },
                version: { versionId: 'v2', packageDigest: 'digest-now' }
              }
            })
      }
      if (method === 'bots.share.stop') {
        return ok({ status: 'ok', value: true })
      }
      return refused(method)
    }
  })
}

const shared = (digest: string): BotShareLink => ({
  shareId: 's1',
  url: URL,
  versionId: 'v1',
  updatedAt: '2026-11-09T20:12:00.000Z',
  digest
})

async function click(name: string): Promise<void> {
  for (let tries = 0; tries < 60; tries++) {
    const button = [...document.querySelectorAll<HTMLElement>('button,[role="button"]')].find(
      (entry) => entry.textContent?.trim().startsWith(name) && !entry.hasAttribute('disabled')
    )
    if (button) {
      button.click()
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300))

const base = { width: 760, store: { orcaProfileAuthStatus: ORCA_CONNECTED } }
const flow = (bot: Bot, link?: BotShareLink | null) => () => (
  <BotShareFlow bot={bot} link={link} onClose={() => {}} />
)

/** (a) Not shared: the bot, its parts, Publish link. */
export const notShared = defineFixture({
  ...base,
  setup: () => stub(),
  render: flow(builder, null)
})
/** Opening: the link slot and the primary wait on the status read. */
export const opening = defineFixture({
  ...base,
  setup: () => stub({ prepare: never, status: never }),
  render: flow(builder)
})
/** (a) Preparing: not shared; the parts still build. */
export const preparing = defineFixture({
  ...base,
  setup: () => stub({ prepare: never }),
  render: flow(builder, null)
})
/** (c) Publishing. */
export const publishing = defineFixture({
  ...base,
  setup: () => stub({ publish: never }),
  render: flow(builder, null),
  interact: () => click('Publish link')
})
/** Published: the link, already copied. */
export const published = defineFixture({
  ...base,
  setup: () => stub(),
  render: flow(builder, null),
  interact: async () => {
    await click('Publish link')
    await settle()
  }
})
/** (b) Shared, the bot changed since: Update link leads. */
export const sharedChanged = defineFixture({
  ...base,
  setup: () => stub(),
  render: flow(builder, shared('digest-then'))
})
/** (b) Shared and up to date: Done leads. */
export const sharedUpToDate = defineFixture({
  ...base,
  setup: () => stub(),
  render: flow(builder, shared('digest-now'))
})
/** (c) Updating. */
export const updating = defineFixture({
  ...base,
  setup: () => stub({ publish: never }),
  render: flow(builder, shared('digest-then')),
  interact: () => click('Update link')
})
/** Updated: same link, not copied again. */
export const updated = defineFixture({
  ...base,
  setup: () => stub(),
  render: flow(builder, shared('digest-then')),
  interact: async () => {
    await click('Update link')
    await settle()
  }
})
/** Stop sharing, confirmed in the footer. */
export const stopConfirm = defineFixture({
  ...base,
  setup: () => stub(),
  render: flow(builder, shared('digest-then')),
  interact: () => click('Stop sharing')
})
/** (d) Publish refused. */
export const publishRefused = defineFixture({
  ...base,
  setup: () => stub({ publish: async () => refused(BOT_SHARE_ERRORS.avatarRefused) }),
  render: flow(builder, null),
  interact: async () => {
    await click('Publish link')
    await settle()
  }
})
/** (d) The link moved in another window: Reload. */
export const linkMoved = defineFixture({
  ...base,
  setup: () => stub({ publish: async () => refused(BOT_SHARE_ERRORS.moved) }),
  render: flow(builder, shared('digest-then')),
  interact: async () => {
    await click('Update link')
    await settle()
  }
})
/** (d) Orca Cloud unreachable. */
export const offline = defineFixture({
  ...base,
  setup: () => stub({ status: async () => refused('fetch failed') }),
  render: flow(builder)
})
/** Signed out of Orca. */
export const signedOut = defineFixture({
  ...base,
  store: signedOutStore(),
  setup: () => stub(),
  render: flow(builder)
})
/** (e) A secret blocks Publish. */
export const secretFound = defineFixture({
  ...base,
  setup: () =>
    stub({
      prepare: async () =>
        ok({
          candidate: candidate({
            blocked: true,
            flags: [
              { where: 'skills/release-notes/SKILL.md', line: 6, kind: 'secret' },
              { where: 'SOUL.md', line: 3, kind: 'sudo' }
            ]
          })
        })
    }),
  render: flow(builder, null)
})
/** (e) Warnings only: Publish stays on. */
export const warnings = defineFixture({
  ...base,
  setup: () =>
    stub({
      prepare: async () =>
        ok({
          candidate: candidate({
            flags: [
              { where: 'SOUL.md', line: 3, kind: 'sudo' },
              { where: 'SOUL.md', line: 9, kind: 'pipe-to-shell' }
            ]
          })
        })
    }),
  render: flow(builder, null)
})
/** Memory on, from the last published picks. */
export const memoryOn = defineFixture({
  ...base,
  setup: () =>
    stub({
      prepare: async () =>
        ok({
          candidate: candidate(),
          last: { selection: { memory: ['MEMORY', 'people', 'release-process'] }, setupNote: '' }
        })
    }),
  render: flow(builder, null)
})
/** Empty parts read "None". */
export const emptyParts = defineFixture({
  ...base,
  setup: () =>
    stub({
      prepare: async () => {
        const base = candidate()
        return ok({
          candidate: candidate({
            notIncluded: ['allowed-tools in orca', 'scripts/run.sh in orca'],
            available: { ...base.available, skills: [], schedules: [] },
            automationIds: { schedules: [], eventSuggestions: [] }
          })
        })
      }
    }),
  render: flow(builder, null)
})
/** A long name and purpose, no picture. */
export const longName = defineFixture({
  ...base,
  setup: () =>
    stub({
      prepare: async () => {
        const base = candidate()
        return ok({
          candidate: candidate({
            bot: {
              ...base.bot,
              name: longBot.name,
              purpose:
                'Runs the weekly release train end to end: cuts the branch, drafts notes from merged PRs, chases blockers in Slack and posts the go or no-go.'
            }
          })
        })
      }
    }),
  render: flow(longBot, null)
})
/** A part's page: Back, its items, the footer stays. */
export const skillsPage = defineFixture({
  ...base,
  setup: () =>
    stub({
      prepare: async () =>
        ok({
          candidate: candidate(),
          last: { selection: { skills: ['orca', 'website'] }, setupNote: '' }
        })
    }),
  render: flow(builder, null),
  interact: () => click('Skills')
})
/** Skills left out: a same-named copy, and ones the packager can't read. */
export const skillsLeftOut = defineFixture({
  ...base,
  setup: () =>
    stub({
      prepare: async () =>
        ok({
          candidate: candidate({
            leftOut: [
              { kind: 'skill', name: 'orca', why: 'duplicate', from: 'team-skills' },
              { kind: 'skill', name: 'deploy', why: 'link' },
              { kind: 'skill', name: 'datasets', why: 'size' }
            ]
          })
        })
    }),
  render: flow(builder, null),
  interact: () => click('Skills')
})
/** Only skills that can't be shared: the Skills row reads None but still opens. */
export const skillsAllLeftOut = defineFixture({
  ...base,
  setup: () =>
    stub({
      prepare: async () => {
        const base = candidate()
        return ok({
          candidate: candidate({
            bot: { ...base.bot, skills: [] },
            available: { ...base.available, skills: [] },
            leftOut: [{ kind: 'skill', name: 'deploy', why: 'link' }]
          })
        })
      }
    }),
  render: flow(builder, null)
})
