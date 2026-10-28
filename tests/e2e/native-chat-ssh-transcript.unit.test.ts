import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../src/shared/agent-status-types'
import type { NativeChatMessage } from '../../src/shared/native-chat-types'
import { eraseRpcMethods, type RpcContext } from '../../src/main/runtime/rpc/core'
import { NATIVE_CHAT_METHODS } from '../../src/main/runtime/rpc/methods/native-chat'

const CONNECTION_ID = 'ssh-target-26057'
const SESSION_ID = 'claude-session-26057'

let hookRows: Partial<AgentStatusIpcPayload>[] = []

function claudeLines(...texts: string[]): string {
  return texts
    .map((text, index) =>
      JSON.stringify({
        sessionId: SESSION_ID,
        uuid: `${SESSION_ID}-${index}`,
        timestamp: '2026-10-07T03:00:00.000Z',
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text }] }
      })
    )
    .map((line) => `${line}\n`)
    .join('')
}

function sshHookRow(transcriptPath: string): Partial<AgentStatusIpcPayload> {
  return {
    paneKey: 'tab-1:leaf-1',
    connectionId: CONNECTION_ID,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: SESSION_ID, transcriptPath }
  }
}

const METHODS = eraseRpcMethods(NATIVE_CHAT_METHODS)

type SubscriptionRuntime = Pick<
  RpcContext['runtime'],
  'registerSubscriptionCleanup' | 'cleanupSubscription'
>

function phoneContext(runtime: Partial<SubscriptionRuntime>): RpcContext {
  const members = { ...runtime, getAgentProviderSessionRows: () => hookRows }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: native chat handlers use only the hook rows and the subscription-cleanup members.
  const handlerRuntime = members as unknown as RpcContext['runtime']
  return { runtime: handlerRuntime, connectionId: 'phone-1', clientKind: 'mobile' }
}

function method(name: string): (typeof METHODS)[number] {
  const found = METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`${name} is not registered`)
  }
  return found
}

function texts(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('messages' in value)) {
    return []
  }
  const messages: readonly NativeChatMessage[] = Array.isArray(value.messages) ? value.messages : []
  return messages.flatMap((message) =>
    message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
  )
}

async function readSession(
  transcriptPath: string
): Promise<{ texts: string[]; error: unknown; notFound: unknown }> {
  const read = method('nativeChat.readSession')
  if ('stream' in read) {
    throw new Error('nativeChat.readSession is a stream')
  }
  const page = await read.handler(
    { agent: 'claude', sessionId: SESSION_ID, transcriptPath },
    phoneContext({})
  )
  return {
    texts: texts(page),
    error: page && typeof page === 'object' && 'error' in page ? page.error : undefined,
    notFound: page && typeof page === 'object' && 'notFound' in page ? page.notFound : undefined
  }
}

describe('native chat for an agent whose transcript lives on an SSH host (#26057)', () => {
  let localDir: string
  // A same-named local transcript must not override the remote hook's conversation.
  let transcriptPath: string

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), 'orca-ssh-transcript-'))
    transcriptPath = join(localDir, 'projects', 'p', `${SESSION_ID}.jsonl`)
    mkdirSync(dirname(transcriptPath), { recursive: true })
    writeFileSync(transcriptPath, claudeLines('LOCAL MACHINE FILE'))
    hookRows = [sshHookRow(transcriptPath)]
  })

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true })
  })

  it.each([false, true])(
    'negotiates reader and every stream representation before slicing (modern=%s)',
    async (modern) => {
      const { NativeChatSession } = await import('../../src/shared/rpc-contract/native-chat-params')
      const { compareNativeChatTranscriptMessages } =
        await import('../../src/shared/native-chat-transcript-projection')
      const { parseRuntimeNativeChatReadSessionResult } =
        await import('../../src/renderer/src/components/native-chat/native-chat-runtime-contract')
      const { createNativeChatMessageListProjection } =
        await import('../../src/renderer/src/components/native-chat/native-chat-message-list-projection')
      const { commandMarkersAsMessages } =
        await import('../../src/renderer/src/components/native-chat/native-chat-command-marker')
      hookRows = [{ ...sshHookRow(transcriptPath), connectionId: null }]
      const line = (id: string, seconds: number) =>
        `${JSON.stringify({
          type: 'assistant',
          uuid: id,
          timestamp: `2026-06-01T10:00:${String(seconds).padStart(2, '0')}.000Z`,
          message: { role: 'assistant', content: id }
        })}\n`
      writeFileSync(transcriptPath, line('z-first', 30) + line('a-second', 10))
      const params = NativeChatSession.parse({
        agent: 'claude',
        sessionId: SESSION_ID,
        transcriptPath,
        limit: 2,
        ...(modern ? { capabilities: { transcriptSourceOrder: 1 } } : {})
      })
      const read = method('nativeChat.readSession')
      const subscribe = method('nativeChat.subscribe')
      if ('stream' in read || !('stream' in subscribe)) {
        throw new Error('Unexpected RPC method kind')
      }
      const parse = (payload: unknown) => {
        const result = parseRuntimeNativeChatReadSessionResult(payload)
        if (!('messages' in result)) {
          throw new Error(result.error)
        }
        return result.messages
      }
      const rows = parse(await read.handler(params, phoneContext({})))
      const time = Date.parse('2026-06-01T10:00:00Z')
      expect(rows.map((row) => row.timestamp)).toEqual(
        modern ? [time + 30000, time + 10000] : [time + 30000, time + 30001]
      )
      expect(rows.map((row) => row.transcriptOrder)).toEqual(
        modern ? [0, Buffer.byteLength(line('z-first', 30))] : [undefined, undefined]
      )
      const marker = commandMarkersAsMessages([
        { id: 'compact', command: '/compact', sentAt: time + 20000 }
      ])[0]
      const ordered = modern
        ? createNativeChatMessageListProjection()([...rows, marker]).conversation
        : [...rows, marker].sort(compareNativeChatTranscriptMessages)
      expect(ordered.map((row) => row.id)).toEqual([marker.id, 'z-first', 'a-second'])
      // The previous nested schema strips the unknown semantic on a new-client/old-host request.
      const oldSchema = NativeChatSession.extend({
        capabilities: NativeChatSession.shape.capabilities
          .unwrap()
          .omit({ transcriptSourceOrder: true })
          .optional()
      })
      const oldParams = oldSchema.parse({ ...params, capabilities: { transcriptSourceOrder: 1 } })
      expect(oldParams.capabilities).toEqual({})
      expect(
        parse(await read.handler(oldParams, phoneContext({}))).map((row) => row.transcriptOrder)
      ).toEqual([undefined, undefined])
      let cleanup = () => {}
      const context = phoneContext({
        registerSubscriptionCleanup: (_key, stop) => {
          cleanup = stop
        }
      })
      const frames: { type: unknown; messages: NativeChatMessage[] }[] = []
      await subscribe.handler(params, context, (frame) => {
        if (frame && typeof frame === 'object' && 'type' in frame && 'messages' in frame) {
          frames.push({ type: frame.type, messages: parse(frame) })
        }
      })
      try {
        await expect.poll(() => frames.length, { timeout: 5000 }).toBe(1)
        expect(frames[0]).toMatchObject({ type: 'snapshot', messages: rows })
        appendFileSync(transcriptPath, line('next', 5))
        await expect.poll(() => frames.length, { timeout: 5000 }).toBe(2)
        expect(frames[1]).toMatchObject({
          type: 'appended',
          messages: [{ id: 'next', timestamp: modern ? time + 5000 : time + 30002 }]
        })
        expect(frames[1].messages[0].transcriptOrder).toBe(
          modern ? Buffer.byteLength(line('z-first', 30) + line('a-second', 10)) : undefined
        )
        writeFileSync(transcriptPath, line('replacement', 1))
        await expect.poll(() => frames.length, { timeout: 5000 }).toBe(3)
        expect(frames[2]).toMatchObject({
          type: 'replacement',
          messages: [{ id: 'replacement', timestamp: time + 1000 }]
        })
        expect(frames[2].messages[0].transcriptOrder).toBe(modern ? 0 : undefined)
        appendFileSync(transcriptPath, line('after-replacement', 0))
        await expect.poll(() => frames.length, { timeout: 5000 }).toBe(4)
        expect(frames[3].messages[0].timestamp).toBe(modern ? time : time + 1001)
      } finally {
        cleanup()
      }
    }
  )

  it('never answers from this machine for an SSH-hosted transcript', async () => {
    const page = await readSession(transcriptPath)

    expect(page.texts).toEqual([])
    expect(page.error).toBeDefined()
  })

  it('keeps reading a local session from this machine', async () => {
    hookRows = [{ ...sshHookRow(transcriptPath), connectionId: null }]

    const page = await readSession(transcriptPath)

    expect(page.texts).toEqual(['LOCAL MACHINE FILE'])
  })
})
