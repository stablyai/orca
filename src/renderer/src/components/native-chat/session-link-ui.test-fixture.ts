import {
  SessionLink,
  SessionLinkEvent,
  SessionLinkParticipant
} from '../../../../shared/session-link'

export const source = SessionLinkParticipant.parse({
  sessionId: 'codex-checkout',
  conversationId: 'codex-checkout',
  name: 'Checkout implementation',
  agent: 'codex',
  role: 'implementer',
  workspaceId: 'app',
  directory: '/projects/acme/app',
  branch: 'feature/checkout',
  task: 'Implement checkout slice 2; stop before paid verification.',
  context: ''
})
export const partner = SessionLinkParticipant.parse({
  sessionId: 'claude-review',
  conversationId: 'claude-review',
  name: 'Checkout architecture and review',
  agent: 'claude',
  role: 'reviewer',
  workspaceId: 'review',
  directory: '/projects/acme/review',
  branch: 'main',
  task: 'Review the checkout flow and tasks 1–5.',
  context: ''
})
export const link = SessionLink.parse({
  id: 'demo-link',
  story: 'Checkout flow · slice 2',
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
export const report = SessionLinkEvent.parse({
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
  body: 'Tasks 1–5 are ready. Local checks pass. Please review before paid verification; no spending has been authorized.'
})
