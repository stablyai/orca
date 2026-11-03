import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  SessionLink,
  SessionLinkEvent,
  SessionLinkParticipant,
  SESSION_LINK_CAPABILITY
} from '../../../../shared/session-link'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
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

function setup(state: 'create' | 'waiting' | 'paused' | 'ended') {
  setLocalRuntimeCapabilitiesForTests([SESSION_LINK_CAPABILITY])
  const snapshot =
    state === 'create'
      ? null
      : {
          link: {
            ...link,
            state: state === 'waiting' ? 'active' : state,
            reason: state === 'paused' ? 'owner-decision' : state === 'ended' ? 'end' : ''
          },
          events: [report]
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
