import { useAppStore } from '@/store'
import { loadRendererUiLanguage, i18n } from '@/i18n/i18n'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  SessionLink,
  SessionLinkEvent,
  SessionLinkParticipant,
  SESSION_LINK_POLICY_CAPABILITY,
  SESSION_LINK_CAPABILITY
} from '../../../../shared/session-link'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { SessionLinkOwnerQuestion } from './SessionLinkOwnerQuestion'
import { SessionLinkControl } from './SessionLinkControl'

const source = SessionLinkParticipant.parse({
  sessionId: 'codex-registry',
  conversationId: 'codex-registry',
  name: 'Reading registry implementation',
  agent: 'codex',
  role: 'implementer',
  workspaceId: 'registry',
  directory: '/projects/djinn/deid-reading-registry',
  branch: 'deid-reading-registry',
  task: 'Implement slice 1b; stop before paid corpus measurements.',
  context: ''
})
const partner = SessionLinkParticipant.parse({
  sessionId: 'claude-djinn',
  conversationId: 'claude-djinn',
  name: 'Slice 1b architecture and review',
  agent: 'claude',
  role: 'reviewer',
  workspaceId: 'djinn',
  directory: '/projects/djinn',
  branch: 'main',
  task: 'Review the privacy boundaries and tasks 1–5.',
  context: ''
})
const link = SessionLink.parse({
  id: 'demo-link',
  story: 'De-identification · slice 1b',
  policy: { turnLimit: null },
  participants: [source, partner],
  state: 'active',
  reason: '',
  version: 1,
  turns: 3,
  messages: 1,
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_001_000
})
const report = SessionLinkEvent.parse({
  id: 'checkpoint',
  linkId: link.id,
  actor: source.sessionId,
  recipient: partner.sessionId,
  kind: 'checkpoint',
  messageId: 'mail-report',
  replyTo: null,
  state: 'accepted',
  operationId: 'report-operation',
  createdAt: 1_800_000_001_000,
  detail: '',
  body: 'Tasks 1–5 are ready. Local checks pass. Please review before corpus measurements; no spending or holdout access has been authorized.'
})

function setup(state: 'create' | 'waiting' | 'paused' | 'ended' | 'unknown') {
  setLocalRuntimeCapabilitiesForTests([SESSION_LINK_CAPABILITY, SESSION_LINK_POLICY_CAPABILITY])
  const snapshot =
    state === 'create'
      ? null
      : {
          link: {
            ...link,
            state: state === 'waiting' ? 'active' : state === 'unknown' ? 'paused' : state,
            reason:
              state === 'unknown'
                ? 'delivery-unknown'
                : state === 'paused'
                  ? 'owner-decision'
                  : state === 'ended'
                    ? 'end'
                    : ''
          },
          events: [
            ...(state === 'paused'
              ? [
                  {
                    ...report,
                    id: 'owner-question',
                    actor: partner.sessionId,
                    recipient: null,
                    kind: 'owner-request',
                    messageId: null,
                    state: 'recorded',
                    body: 'Approve a paid verification run up to $0.10, or continue with offline checks only?'
                  }
                ]
              : []),
            state === 'unknown'
              ? { ...report, state: 'blocked', retryable: false, detail: 'delivery-unknown' }
              : report
          ]
        }
  window.api.runtime.call = async (request) => ({
    id: 'fixture',
    ok: true,
    _meta: { runtimeId: 'fixture' },
    result:
      request.method === 'orchestration.linkCandidates'
        ? { source, candidates: [partner], history: [] }
        : snapshot
  })
}
async function openDialog(frame: HTMLElement) {
  for (let i = 0; i < 10 && !frame.querySelector('button'); i++) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  frame.querySelector<HTMLButtonElement>('button')?.click()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}
const render = () => (
  <div className="p-4">
    <div className="relative h-6">
      <div className="pane-title-bar" data-chromeless="">
        <div className="pane-title-actions ml-auto flex items-center">
          <SessionLinkControl sessionId={source.sessionId} target={{ kind: 'local' }} />
        </div>
      </div>
    </div>
  </div>
)
export const create = defineFixture({
  width: 720,
  setup: () => setup('create'),
  render,
  interact: openDialog
})
export const waiting = defineFixture({
  width: 720,
  setup: () => setup('waiting'),
  render,
  interact: openDialog
})
export const paused = defineFixture({
  width: 720,
  setup: () => setup('paused'),
  render,
  interact: openDialog
})
export const ended = defineFixture({
  width: 720,
  setup: () => setup('ended'),
  render,
  interact: openDialog
})
export const narrow = defineFixture({
  width: 360,
  setup: () => setup('waiting'),
  render,
  interact: openDialog
})

export const unknown = defineFixture({
  width: 720,
  setup: () => setup('unknown'),
  render,
  interact: async (frame) => {
    await openDialog(frame)
    document.querySelectorAll('summary').forEach((s) => {
      if (s.textContent === 'Review unconfirmed delivery') {
        s.click()
      }
    })
  }
})

export const fromTabs = defineFixture({
  width: 720,
  setup: () => setup('create'),
  render: () => (
    <div className="h-[680px] bg-background">
      <SessionLinkControl
        sessionId={source.sessionId}
        target={{ kind: 'local' }}
        initialPartnerSessionId={partner.sessionId}
        dialogOnly
      />
    </div>
  )
})

export const ownerDecisionNarrow = defineFixture({
  width: 360,
  setup: () => setup('paused'),
  render,
  interact: openDialog
})
export const policySettings = defineFixture({
  width: 720,
  setup: () => setup('waiting'),
  render,
  interact: async (frame) => {
    await openDialog(frame)
    for (let i = 0; i < 10; i++) {
      const summary = [...document.querySelectorAll('summary')].find(
        (node) => node.textContent === 'Collaboration limits'
      )
      if (summary) {
        summary.click()
        break
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }
})

export const ownerQuestionInChat = defineFixture({
  width: 360,
  setup: () => setup('paused'),
  render: () => <SessionLinkOwnerQuestion sessionId={source.sessionId} />
})

export const ownerQuestionRussian = defineFixture({
  width: 360,
  setup: async () => {
    setup('paused')
    const settings = useAppStore.getState().settings
    if (!settings) {
      throw new Error('Fixture settings are not initialized')
    }
    useAppStore.setState({ settings: { ...settings, uiLanguage: 'ru' } })
    await i18n.changeLanguage(await loadRendererUiLanguage('ru'))
  },
  render: () => <SessionLinkOwnerQuestion sessionId={source.sessionId} />
})

const longOwnerQuestion = `Offline checks passed. Should we run the next verification stage with a maximum budget of $0.10, or continue using offline evidence only?

The implementation report is at /projects/djinn/deid-reading-registry/docs/experiments/reading-slice-1b/checkpoint-report.md. The reviewer recorded the remaining limits at https://example.test/reviews/de-identification/slice-1b/privacy-boundary-and-verification.

The run will use the configured provider and the existing data boundary. No corpus access or spending has been approved yet. Your choice will be delivered to both agents before the link resumes.`

function setupLongOwnerQuestion() {
  setup('paused')
  window.api.runtime.call = async () => ({
    id: 'fixture',
    ok: true,
    _meta: { runtimeId: 'fixture' },
    result: {
      link: { ...link, state: 'paused', reason: 'owner-decision' },
      events: [
        {
          ...report,
          id: 'owner-question',
          actor: partner.sessionId,
          recipient: null,
          kind: 'owner-request',
          messageId: null,
          state: 'recorded',
          body: longOwnerQuestion,
          choices: [
            {
              label: 'Approve up to $0.10',
              description: 'Run the verification within the existing data boundary.'
            },
            {
              label: 'Continue offline only',
              description: 'Keep working without provider calls or spending.'
            },
            {
              label: 'Stop for review',
              description: 'Leave the link paused until I review the report.'
            }
          ],
          allowOther: true
        }
      ]
    }
  })
}

const renderOwnerQuestion = () => (
  <div className="native-chat-appearance bg-chat-pane">
    <SessionLinkOwnerQuestion sessionId={source.sessionId} />
  </div>
)
export const ownerQuestion390 = defineFixture({
  width: 390,
  setup: setupLongOwnerQuestion,
  render: renderOwnerQuestion
})
export const ownerQuestion560 = defineFixture({
  width: 560,
  setup: setupLongOwnerQuestion,
  render: renderOwnerQuestion
})
export const ownerQuestion800 = defineFixture({
  width: 800,
  setup: setupLongOwnerQuestion,
  render: renderOwnerQuestion
})
