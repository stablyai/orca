import { describe, expect, it } from 'vitest'
import { AI_VAULT_AGENTS } from '../ai-vault-types'
import {
  MOBILE_WEB_AGENT_HISTORY_AGENTS,
  MOBILE_WEB_AGENT_HISTORY_PAGE_LIMIT,
  MOBILE_WEB_AGENT_HISTORY_PREVIEW_LIMIT,
  MobileWebAgentHistoryPreviewResultSchema,
  MobileWebAgentHistoryResumePayloadSchema,
  MobileWebAgentHistorySnapshotPayloadSchema,
  MobileWebAgentHistorySnapshotResultSchema
} from './agent-history-operation-contract'

const SESSION = {
  sessionId: 'provider-session-1',
  agent: 'codex',
  agentLabel: 'Codex',
  title: 'Continue mobile migration',
  lastMessage: 'The hosted route now uses the existing mobile panel.',
  messageCount: 12,
  updatedAt: 1_753_500_000_000,
  groupKey: 'project_opaque_1',
  groupLabel: 'orca',
  isCurrentWorkspace: true,
  resumeAvailable: true
} as const

describe('mobile web agent-history operation contract', () => {
  it('keeps the browser-pure agent enum aligned with the host authority', () => {
    expect(MOBILE_WEB_AGENT_HISTORY_AGENTS).toEqual(AI_VAULT_AGENTS)
  })

  it('accepts bounded snapshot, preview, and resume values', () => {
    expect(
      MobileWebAgentHistorySnapshotPayloadSchema.parse({
        workspaceId: 'workspace_opaque_1',
        scope: 'workspace',
        query: 'mobile',
        force: false
      })
    ).toMatchObject({ scope: 'workspace', query: 'mobile' })
    expect(
      MobileWebAgentHistorySnapshotResultSchema.parse({
        supported: true,
        sessions: [SESSION],
        skippedTranscriptCount: 0,
        nextOffset: null
      }).sessions
    ).toEqual([SESSION])
    expect(
      MobileWebAgentHistoryPreviewResultSchema.parse({
        messages: [{ role: 'assistant', text: 'Ready to resume.' }]
      }).messages
    ).toHaveLength(1)
    expect(
      MobileWebAgentHistoryResumePayloadSchema.parse({
        workspaceId: 'workspace_opaque_1',
        scope: 'workspace',
        agent: SESSION.agent,
        sessionId: SESSION.sessionId
      })
    ).toMatchObject({ agent: SESSION.agent, sessionId: SESSION.sessionId })
  })

  /** The provider session id is what the page addresses a session by, so it is published on
   *  purpose. Everything host-shaped around it still has to stay behind the projection. */
  it('rejects host paths, commands, and unbounded pages', () => {
    for (const privateField of ['cwd', 'filePath', 'resumeCommand', 'id']) {
      expect(
        MobileWebAgentHistorySnapshotResultSchema.safeParse({
          supported: true,
          sessions: [{ ...SESSION, [privateField]: '/private/host/value' }],
          skippedTranscriptCount: 0,
          nextOffset: null
        }).success
      ).toBe(false)
    }
    expect(
      MobileWebAgentHistorySnapshotResultSchema.safeParse({
        supported: true,
        sessions: Array.from({ length: MOBILE_WEB_AGENT_HISTORY_PAGE_LIMIT + 1 }, () => SESSION),
        skippedTranscriptCount: 0,
        nextOffset: null
      }).success
    ).toBe(false)
    expect(
      MobileWebAgentHistoryPreviewResultSchema.safeParse({
        messages: Array.from({ length: MOBILE_WEB_AGENT_HISTORY_PREVIEW_LIMIT + 1 }, () => ({
          role: 'user',
          text: 'hello'
        }))
      }).success
    ).toBe(false)
  })

  it('rejects unknown agents and raw resume targets', () => {
    expect(
      MobileWebAgentHistorySnapshotResultSchema.safeParse({
        supported: true,
        sessions: [{ ...SESSION, agent: 'unknown-provider' }],
        skippedTranscriptCount: 0,
        nextOffset: null
      }).success
    ).toBe(false)
    expect(
      MobileWebAgentHistoryResumePayloadSchema.safeParse({
        workspaceId: 'workspace_opaque_1',
        scope: 'workspace',
        agent: SESSION.agent,
        sessionId: SESSION.sessionId,
        command: "cd '/secret' && codex resume provider-session-id"
      }).success
    ).toBe(false)
  })
})
