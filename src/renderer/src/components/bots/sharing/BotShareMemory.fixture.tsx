// The Share dialog's Memory page against a stubbed runtime: 24 seeded files, a secret, a warning, a long name.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotShareCandidateSummary } from '../../../../../shared/bots/bot-package'
import { ORCA_CONNECTED } from '../orca-sign-in.test-fixture'
import { BotShareFlow } from './BotShareFlow'

const bot: Bot = {
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

const MEMORY: [string, number][] = [
  ['36078-d1-ctx-2d7fce446b61', 2],
  ['agent-hook-entry-gate', 13],
  ['agent-hook-uninstall', 21],
  ['app-rail', 211],
  ['author-ui-01', 10],
  ['author-ui-02', 11],
  ['author-ui-03', 5],
  ['automation-chat-run-lifecycle', 43],
  ['automation-right-click-delete-and-undo-across-paired-hosts-and-folders', 27],
  ['bot-activity', 7],
  ['bot-attention-evidence-20261111', 11],
  ['bot-drag-preview', 7],
  ['bots-docs', 23],
  ['chat-fold-counts', 18],
  ['chat-resume-toast', 9],
  ['codex-session-move', 31],
  ['cursor-first-turn', 14],
  ['drag-split-to-tab', 26],
  ['end-bot-chat', 40],
  ['item-page-header', 22],
  ['link-open-default', 57],
  ['raw-mention', 188],
  ['remote-host-indicator', 12],
  ['slack-dm-preview', 16]
]

function candidate(secret: boolean, files = MEMORY): BotShareCandidateSummary {
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
      skills: [],
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
      skills: [],
      schedules: [],
      eventSuggestions: [],
      tools: [],
      memory: files.map(([topic, lines]) => ({ topic, lines }))
    },
    automationIds: { schedules: [], eventSuggestions: [] },
    flags: [
      ...(secret ? [{ where: 'memory/app-rail.md', line: 42, kind: 'secret' as const }] : []),
      { where: 'memory/automation-chat-run-lifecycle.md', line: 7, kind: 'sudo' }
    ],
    blocked: false,
    expiresAt: '2099-01-01T00:00:00.000Z'
  }
}

const stub =
  (secret: boolean, files = MEMORY) =>
  (): void => {
    const runtime: unknown = window.api.runtime
    Reflect.set(window.api, 'runtime', {
      ...(typeof runtime === 'object' ? runtime : {}),
      call: async ({ method }: { method: string }) =>
        method === 'bots.share.prepare'
          ? { ok: true, result: { candidate: candidate(secret, files) } }
          : method === 'bots.share.status'
            ? { ok: true, result: { status: 'ok', value: [] } }
            : { ok: false, error: { code: 'runtime_error', message: method } }
    })
  }

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 300))

async function find(selector: string): Promise<HTMLElement | null> {
  for (let tries = 0; tries < 60; tries++) {
    const found = document.querySelector<HTMLElement>(selector)
    if (found && !found.hasAttribute('disabled')) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return null
}

/** Include memory on (every file), then leave all but three out. */
async function openPartial(): Promise<void> {
  ;(await find('[role="switch"][aria-label="Include memory"]'))?.click()
  ;(await find('[role="switch"][aria-label="All"]'))?.click()
  for (const name of ['app-rail', 'bots-docs', 'raw-mention']) {
    ;(await find(`[role="checkbox"][aria-label="${name}"]`))?.click()
  }
  await settle()
}

const base = {
  width: 760,
  store: { orcaProfileAuthStatus: ORCA_CONNECTED },
  setup: stub(true),
  render: () => <BotShareFlow bot={bot} link={null} onClose={() => {}} />
}

/** A partial pick: All reads off, the title counts 3 of 24. */
export const partial = defineFixture({ ...base, interact: openPartial })
/** Include memory just turned on: every file picked, All on. */
export const allPicked = defineFixture({
  ...base,
  interact: async () => {
    ;(await find('[role="switch"][aria-label="Include memory"]'))?.click()
    await settle()
  }
})
/** A dialog squeezed to 380px: the footer hint takes a line of its own above the buttons. */
export const narrow = defineFixture({
  ...base,
  setup: stub(false),
  interact: async () => {
    await openPartial()
    // The dialog follows the window, not the frame; pin it narrow to show the wrap.
    const dialog = await find('[data-slot="dialog-content"]')
    dialog?.style.setProperty('max-width', '380px')
    await settle()
  }
})
/** The flagged row's tooltip names the line. */
export const flagTooltip = defineFixture({
  ...base,
  interact: async () => {
    await openPartial()
    const icon = await find('[data-slot="tooltip-trigger"]')
    icon?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
    await settle()
    await settle()
  }
})
/** Keyboard focus on a row's preview: the eye shows with its ring. */
export const previewFocus = defineFixture({
  ...base,
  interact: async () => {
    await openPartial()
    ;(await find('button[aria-label="Preview bots-docs"]'))?.focus()
    await settle()
  }
})
/** 70 files, past the 64 a share carries: Include memory picks the first 64. */
export const overLimit = defineFixture({
  ...base,
  setup: stub(true, [
    ...MEMORY,
    ...Array.from({ length: 46 }, (_, index): [string, number] => [`note-${index + 1}`, 8])
  ]),
  interact: async () => {
    ;(await find('[role="switch"][aria-label="Include memory"]'))?.click()
    await settle()
  }
})
/** The same, scrolled to the end: the six left over are greyed until a picked one goes. */
export const overLimitEnd = defineFixture({
  ...overLimit,
  interact: async () => {
    await overLimit.interact?.(document.body)
    document.querySelector('[role="checkbox"][aria-label="note-46"]')?.scrollIntoView()
    await settle()
  }
})
