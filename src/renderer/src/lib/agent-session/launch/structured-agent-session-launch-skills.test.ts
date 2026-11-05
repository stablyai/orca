// @vitest-environment happy-dom
import {
  mocks,
  resetCreateMessageFixture,
  cleanupCreateMessageFixture,
  deferred,
  createParams,
  target
} from '../../structured-agent-session-launch-create-message.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startStructuredAgentLaunch } from './structured-agent-session-launch'
import { StructuredAgentSessionCreateRefusalError } from './structured-agent-session-launch-errors'
import { newAgentLaunchRequestId } from '../../agent-launch-request-id'
import { structuredAgentSessionCreateFingerprint } from '../../../../../shared/agent-session/lifecycle/structured-agent-session-mutation'
import { sendStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-sender'
import { noteStructuredAgentSessionFence } from '@/components/native-chat/structured-agent-session-send-attempt'
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import {
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey
} from '@/components/native-chat/native-chat-composer-draft-store'
import { promptSkillRefs } from '@/components/native-chat/native-chat-prompt-document'

const skills = [{ name: 'audit', path: '/repo/.agents/skills/audit/SKILL.md' }]
const prompt = '$audit check this'
let restoreCatalogStore: (() => void) | undefined

describe('launch skill compatibility at create and send', () => {
  beforeEach(() => {
    restoreCatalogStore = resetCreateMessageFixture()
  })
  afterEach(() => {
    cleanupCreateMessageFixture(restoreCatalogStore)
  })

  it.each([false, true])(
    'gates first-message skill paths independently of create-message support (%s)',
    async (takesSkills) => {
      mocks.exactSupport.mockResolvedValue(takesSkills)
      const create = deferred<unknown>()
      mocks.call.mockReturnValue(create.promise)
      const launch = startStructuredAgentLaunch('workspace-1', 'codex', {
        requestId: newAgentLaunchRequestId(),
        executionHostId: 'local',
        prompt,
        promptSkills: skills
      })
      await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
      const params = createParams()
      expect(params.firstMessage?.body.blocks).toEqual([{ type: 'text', text: prompt }])
      if (takesSkills) {
        expect(params.firstMessage?.body.skills).toEqual(skills)
      } else {
        expect(params.firstMessage?.body).not.toHaveProperty('skills')
      }
      expect(getStructuredAgentSessionPendingSends(launch.sessionId)[0]?.body.skills).toEqual(
        skills
      )
      expect(params.envelope.payloadFingerprint).toBe(
        structuredAgentSessionCreateFingerprint({ sessionId: launch.sessionId, ...params })
      )
      create.resolve({
        ok: false,
        refusal: { code: 'structured_agent_session_unsupported', message: 'unavailable' }
      })
      await expect(launch.launchResult).rejects.toBeInstanceOf(
        StructuredAgentSessionCreateRefusalError
      )
      await launch.promptDeliveryResult
      const returned = readNativeChatComposerDraft(
        structuredAgentSessionDraftScopeKey(launch.sessionId)
      )
      expect(returned.text).toBe(prompt)
      expect(promptSkillRefs(returned.document)).toEqual(skills)
      expect(mocks.call.mock.calls.map(([, method]) => method)).toEqual(['agentSession.create'])
    }
  )

  it.each([false, true])(
    'sends skill paths only to a supporting host (%s), keeping them for handback',
    async (takesSkills) => {
      mocks.exactSupport.mockResolvedValue(takesSkills)
      mocks.call.mockResolvedValue({
        ok: false,
        refusal: {
          code: 'agent_session_conflict',
          message: 'busy',
          details: { reason: 'chatStarting' }
        }
      })
      const sessionId = 'session-skills'
      noteStructuredAgentSessionFence(sessionId, 4)
      const sent = sendStructuredAgentSessionMessage({ sessionId, target, text: prompt, skills })!
      expect(await sent.outcome).toBe('returned')
      const params = mocks.call.mock.calls.find(([, method]) => method === 'agentSession.send')?.[2]
      expect(params).toMatchObject({ body: { blocks: [{ type: 'text', text: prompt }] } })
      expect(params).toMatchObject({ body: takesSkills ? { skills } : {} })
      if (!takesSkills) {
        expect(params).not.toHaveProperty('body.skills')
      }
      const returned = readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(sessionId))
      expect(returned.text).toBe(prompt)
      expect(promptSkillRefs(returned.document)).toEqual(skills)
    }
  )
})
