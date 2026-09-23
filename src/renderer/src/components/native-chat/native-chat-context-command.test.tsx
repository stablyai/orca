// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '../../../../shared/agent-session-option-catalog'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import { clearNativeChatSessionOptionCacheForTests } from './native-chat-session-option-cache'
import {
  answerNativeChatLocalCommand,
  type NativeChatLocalCommandAnswer
} from './use-native-chat-local-command-answer'
import { useNativeChatPickerCommandDispatch } from './use-native-chat-picker-command-dispatch'
import { useNativeChatPtyComposerSend } from './use-native-chat-pty-composer-send'

const mocks = vi.hoisted(() => ({
  sendNativeChatMessage: vi.fn(() => ({ id: 'send' })),
  sendNativeChatMessageWithImageAttachments: vi.fn(() => ({ id: 'image-send' }))
}))

vi.mock('../../store', () => {
  const state = { clearNativeChatLaunchDraft: vi.fn() }
  return { useAppStore: { getState: () => state } }
})
vi.mock('./native-chat-runtime-send', () => ({
  sendNativeChatMessage: mocks.sendNativeChatMessage,
  sendNativeChatTypedCommand: vi.fn(),
  submitNativeChatPrompt: vi.fn()
}))
vi.mock('./native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: mocks.sendNativeChatMessageWithImageAttachments
}))
vi.mock('@/lib/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn(),
  emitNativeChatPickerItemAccepted: vi.fn(),
  emitNativeChatSendClassified: vi.fn()
}))

// `omp models --json` rows as OMP 17.0.5 prints them, reduced to what discovery keeps.
const DISCOVERED: CatalogModel[] = [
  { id: 'openai-codex/gpt-5.5', label: 'GPT-5.5', contextWindowTokens: 272_000, options: [] },
  { id: 'openai-codex/gpt-5.4', label: 'GPT-5.4', contextWindowTokens: 1_000_000, options: [] },
  { id: 'anthropic/claude-opus', label: 'Claude Opus', options: [] }
]

// A reply as OMP records it: provider and model on the row, usage per request.
function response(
  promptTokens: number,
  timestamp: number,
  model = 'gpt-5.5',
  provider = 'openai-codex'
): NativeChatMessage {
  return {
    id: `a-${timestamp}`,
    role: 'assistant',
    blocks: [{ type: 'text', text: 'ok' }],
    timestamp,
    source: 'transcript',
    model,
    provider,
    usage: {
      inputTokens: 680,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: promptTokens - 680,
      outputTokens: 16
    }
  }
}

function liveSurface(models?: CatalogModel[]) {
  return createNativeChatPtySessionOptions({
    agent: 'omp',
    scopeKey: 'pty-context',
    ...(models ? { initialModels: models } : {}),
    mode: 'live',
    reportedValues: { model: 'openai-codex/gpt-5.5' },
    dispatchCommand: vi.fn()
  })!
}

beforeEach(() => {
  clearNativeChatSessionOptionCacheForTests()
  mocks.sendNativeChatMessage.mockClear()
  mocks.sendNativeChatMessageWithImageAttachments.mockClear()
})

describe('the context window the model listing states', () => {
  it('reads the window of a listed model once discovery has run', () => {
    const surface = liveSurface(DISCOVERED)
    expect(surface.contextWindowTokens('openai-codex/gpt-5.4')).toBe(1_000_000)
    expect(surface.contextWindowTokens('anthropic/claude-opus')).toBeNull()
    expect(surface.contextWindowTokens('unlisted/model')).toBeNull()
  })

  it('knows no window before discovery', () => {
    expect(liveSurface().contextWindowTokens('openai-codex/gpt-5.5')).toBeNull()
  })

  it('follows a later discovery result', () => {
    const surface = liveSurface()
    surface.replaceModels(DISCOVERED)
    expect(surface.contextWindowTokens('openai-codex/gpt-5.5')).toBe(272_000)
  })
})

describe('answerNativeChatLocalCommand', () => {
  const surface = liveSurface(DISCOVERED)

  function answer(args: { messages: NativeChatMessage[]; command?: string }): string | null {
    return answerNativeChatLocalCommand({
      agent: 'omp',
      command: args.command ?? '/context',
      messages: args.messages,
      contextWindowTokens: surface.contextWindowTokens
    })
  }

  it('states the window of the model that served the last response', () => {
    expect(answer({ messages: [response(21_672, 10)] })).toBe(
      'Context: 21.7k / 272k tokens (8%), estimated from the last response.'
    )
    // A switch in the TUI shows up on the next reply, not in the picker.
    expect(answer({ messages: [response(21_672, 10), response(450_000, 20, 'gpt-5.4')] })).toBe(
      'Context: 450k / 1m tokens (45%), estimated from the last response.'
    )
  })

  it('gives the used figure alone when the listing states no window', () => {
    const used = 'Context: 54.6k tokens used, estimated from the last response.'
    expect(answer({ messages: [response(54_600, 10, 'claude-opus', 'anthropic')] })).toBe(used)
    // The same bare model under a provider the listing does not have.
    expect(answer({ messages: [response(54_600, 10, 'gpt-5.5', 'openrouter')] })).toBe(used)
  })

  it('reports nothing between a compaction and the next response', () => {
    const unavailable =
      'Context usage is not known yet. It becomes available after the agent next responds.'
    const compaction: NativeChatMessage = {
      id: 'c',
      role: 'system',
      blocks: [{ type: 'text', text: 'Context compacted', presentation: 'compaction' }],
      timestamp: 20,
      source: 'transcript'
    }
    const messages = [response(200_000, 10), compaction]
    expect(answer({ messages })).toBe(unavailable)
    expect(answer({ messages: [...messages, response(30_000, 30)] })).toBe(
      'Context: 30k / 272k tokens (11%), estimated from the last response.'
    )
  })

  it('does not promise a later answer when the host never reports usage', () => {
    const pending =
      'Context usage is not known yet. It becomes available after the agent next responds.'
    const {
      model: _model,
      provider: _provider,
      usage: _usage,
      ...olderHostRow
    } = response(54_600, 10)
    // An older host decodes the same reply without its model or usage.
    expect(answer({ messages: [olderHostRow] })).toBe(
      'Context usage is not available for this session.'
    )
    expect(answer({ messages: [] })).toBe(pending)
    // A live preview is not an answer the host decoded.
    expect(answer({ messages: [{ ...olderHostRow, source: 'hook' }] })).toBe(pending)
  })

  it('leaves every other command, and other agents, to the agent', () => {
    expect(answer({ messages: [], command: '/context all' })).not.toBeNull()
    expect(answer({ messages: [], command: '/compact' })).toBeNull()
    expect(answer({ messages: [], command: '/contextual' })).toBeNull()
    expect(answer({ messages: [], command: 'what is my /context' })).toBeNull()
    expect(
      answerNativeChatLocalCommand({
        agent: 'openclaude',
        command: '/context',
        messages: [],
        contextWindowTokens: surface.contextWindowTokens
      })
    ).toBeNull()
  })
})

describe('host-answered /context in the composer', () => {
  const target = { ptyId: 'pty-1', settings: {} }

  function composerArgs(answerCommandLocally: NativeChatLocalCommandAnswer) {
    return {
      agent: 'omp' as const,
      disabled: false,
      isDispatchingSessionOption: false,
      resolveTarget: () => target,
      onSlashCommand: vi.fn(),
      answerCommandLocally,
      sessionOptionsSurface: liveSurface(DISCOVERED),
      trackPendingSend: vi.fn(),
      setHistory: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      clearSkillOrigin: vi.fn(),
      clearImageAttachments: vi.fn(),
      setNotice: vi.fn()
    }
  }

  function typedSend(draft: string, answerCommandLocally: NativeChatLocalCommandAnswer) {
    const args = {
      ...composerArgs(answerCommandLocally),
      draft,
      imageAttachments: [{ path: '/tmp/shot.png' }],
      launchDraftResolved: true,
      classifySend: () => 'command' as const,
      terminalTabId: 'tab-1'
    }
    const { result } = renderHook(() => useNativeChatPtyComposerSend(args))
    result.current()
    return args
  }

  it('answers a typed /context in the chat with the listing windows, keeping attachments', () => {
    const answerCommandLocally = vi.fn<NativeChatLocalCommandAnswer>(
      () => 'Context: 450k / 1m tokens (45%)'
    )
    const args = typedSend('/context', answerCommandLocally)
    expect(answerCommandLocally).toHaveBeenCalledWith('/context', expect.any(Function))
    const windowFor = answerCommandLocally.mock.calls[0]![1]
    expect(windowFor('openai-codex/gpt-5.4')).toBe(1_000_000)
    expect(args.onSlashCommand).toHaveBeenCalledWith('/context', 'Context: 450k / 1m tokens (45%)')
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    expect(mocks.sendNativeChatMessageWithImageAttachments).not.toHaveBeenCalled()
    expect(args.clearImageAttachments).not.toHaveBeenCalled()
    expect(args.setDraft).toHaveBeenCalledWith('')
  })

  it('still sends a command the host does not answer, attachments included', () => {
    const args = typedSend('/compact', () => null)
    expect(mocks.sendNativeChatMessageWithImageAttachments).toHaveBeenCalled()
    expect(args.onSlashCommand).toHaveBeenCalledWith('/compact')
  })

  it('answers a picked /context the same way as a typed one', () => {
    const answerCommandLocally = vi.fn<NativeChatLocalCommandAnswer>(
      () => 'Context: 450k / 1m tokens (45%)'
    )
    const args = { ...composerArgs(answerCommandLocally), setActiveSuggestion: vi.fn() }
    const { result } = renderHook(() => useNativeChatPickerCommandDispatch(args))
    result.current({
      kind: 'command',
      id: 'command:context',
      name: 'context',
      token: '/context',
      skillCollision: false
    })
    expect(answerCommandLocally.mock.calls[0]![1]('openai-codex/gpt-5.5')).toBe(272_000)
    expect(args.onSlashCommand).toHaveBeenCalledWith('/context', 'Context: 450k / 1m tokens (45%)')
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    expect(args.clearImageAttachments).not.toHaveBeenCalled()
    expect(args.setHistory).toHaveBeenCalled()
  })
})
