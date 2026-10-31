// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../src/shared/agent-session-mutation-envelope'
import { claudeSessionIdForOrcaSession } from '../../src/main/claude/structured/claude-structured-session-id'
import { hostTestMessage } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { StructuredAgentSessionStartupAttempts } from '../../src/main/native-chat/agent-session-wire/structured-agent-session-startup-attempt'
import { createScriptedClaudeRuntime } from '../../src/main/runtime/structured-claude-scripted-runtime-test-support'
import { TooltipProvider } from '../../src/renderer/src/components/ui/tooltip'
import { NativeChatSessionOptionPickers } from '../../src/renderer/src/components/native-chat/NativeChatSessionOptionPickers'
import { structuredAgentSessionSeedCatalog } from '../../src/shared/structured-agent-session-seed-catalog'
import {
  applyStructuredAgentSessionOptions,
  createStructuredAgentSessionOptionState,
  structuredAgentSessionOptionSnapshot
} from '../../src/shared/structured-agent-session-options'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, String(value)),
      fallback
    )
}))
afterEach(() => cleanup())

it('picks model then effort through the menus during startup and uses both in the first reply', async () => {
  const SESSION = 'picker-startup-pair'
  const CALLER = { callerKey: 'picker-client' }
  const claude = createScriptedClaudeRuntime([SESSION])
  const picked: Promise<unknown>[] = []
  let operation = 0
  claude.behave(SESSION, { initHangs: true, sendsNoStartFrame: true })
  try {
    const host = await claude.install()
    await host.attach(CALLER, claude.attachParams(SESSION, null, { options: { model: 'opus' } }))
    await vi.waitFor(() => expect(claude.child(SESSION).initializing).toBe(true))
    const child = claude.child(SESSION)
    let replyModel = 'opus'
    let replyEffort = 'high'
    let firstReply: { model: string; effort: string } | undefined
    child.connection.supportedModels = async () =>
      ['sonnet', 'opus'].map((value) => ({
        value,
        displayName: value,
        supportsEffort: true,
        supportedEffortLevels: ['low', 'high']
      }))
    child.connection.setModel = async (value) => {
      replyModel = value ?? 'opus'
    }
    child.connection.applyFlagSettings = async (settings) => {
      if (typeof settings.effortLevel === 'string') {
        replyEffort = settings.effortLevel
      }
    }
    child.connection.getSettings = async () => ({ effective: { effortLevel: replyEffort } })
    child.connection.send = async (_message, beforeDispatch) => {
      await beforeDispatch?.()
      child.calls.push('send')
      firstReply = { model: replyModel, effort: replyEffort }
      child.handlers.onMessage?.({
        type: 'assistant',
        session_id: claudeSessionIdForOrcaSession(SESSION),
        uuid: 'first-reply',
        message: {
          role: 'assistant',
          model: replyModel,
          content: [{ type: 'text', text: firstReply.effort }]
        }
      })
    }
    // Let delivery wake before the callers waiting on the same ready child resume.
    const readiness = StructuredAgentSessionStartupAttempts.prototype.readiness
    const delayed = vi
      .spyOn(StructuredAgentSessionStartupAttempts.prototype, 'readiness')
      .mockImplementation(function (
        this: StructuredAgentSessionStartupAttempts,
        sessionId,
        identity
      ) {
        const selected = readiness.call(this, sessionId, identity)
        return selected
          ? {
              wait: async (budget) => {
                const outcome = await selected.wait(budget)
                await new Promise((resolve) => setTimeout(resolve, 0))
                return outcome
              }
            }
          : null
      })
    const envelope = (method: string, fields: Record<string, unknown>) => ({
      sessionId: SESSION,
      clientOperationId: `${Date.now()}-${(++operation).toString(16).padStart(32, '0')}`,
      expectedRuntimeFence: host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method,
        sessionId: SESSION,
        fields
      })
    })
    const setOption = (key: string, value: string | boolean) => {
      if (typeof value !== 'string') {
        throw new Error('This flow picks select options.')
      }
      const write = host
        .setOption(CALLER, {
          envelope: envelope('agentSession.setOption', { key, value }),
          key,
          value
        })
        .then((result) => {
          expect(result).toMatchObject({ ok: true })
          return { snapshot: [] }
        })
      picked.push(write)
      return write
    }
    const seed = structuredAgentSessionSeedCatalog('claude')
    if (!seed) {
      throw new Error('Claude options are not registered.')
    }
    const snapshot = structuredAgentSessionOptionSnapshot(
      applyStructuredAgentSessionOptions(createStructuredAgentSessionOptionState('claude'), seed, {
        models: ['opus', 'sonnet'].map((id) => ({
          id,
          label: id,
          isDefault: id === 'opus',
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'high', label: 'High' }
          ]
        })),
        current: { model: 'opus', effort: 'high' }
      })
    )
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(NativeChatSessionOptionPickers, {
          surface: {
            getSnapshot: () => snapshot,
            setOption,
            invokeAction: async () => ({ snapshot }),
            subscribe: () => () => {}
          },
          snapshot,
          isWorking: false
        })
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Model opus, Effort High' }))
    fireEvent.click(await screen.findByRole('option', { name: 'sonnet' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Low' }))
    const body = hostTestMessage('reply using these choices')
    await expect(
      host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
    ).resolves.toMatchObject({ ok: true })
    child.answerInit()
    await Promise.all(picked)
    await vi.waitFor(async () => {
      const reply = (await host.journalSnapshot(SESSION)).items.find(
        (item) => item.body.kind === 'message' && item.body.role === 'assistant'
      )
      expect(reply?.body).toMatchObject({
        blocks: [{ type: 'text', text: 'low' }]
      })
    })
    expect(firstReply).toEqual({ model: 'sonnet', effort: 'low' })
    delayed.mockRestore()
  } finally {
    await claude.dispose()
    await Promise.allSettled(picked)
  }
})
