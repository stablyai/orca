import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import * as cliTranscript from '../../../src/main/ai-vault/structured-chat-cli-fork'
import type { RestTestRig } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  createTestParams,
  CREATE_TEST_CALLER
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { HOST_TEST_SESSION } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { structuredAgentRuntimeMetadata } from '../../../src/main/runtime/structured-agent-runtime-metadata'
import { agentSessionProviderHandleChainHead } from '../../../src/shared/agent-session-provider-handle'

export async function prepareReadableSwitchSource(rig: RestTestRig, workspaceId: string) {
  const params = createTestParams()
  await rig.host.create(
    CREATE_TEST_CALLER,
    createTestParams(undefined, {
      location: { ...params.location, workspaceId }
    })
  )
  await rig.host.switchToChat(HOST_TEST_SESSION)
  await rig.host.switchToTerminal(HOST_TEST_SESSION)
  rig.adapter.acquire.mockClear()
  const record = rig.store.getRecord(HOST_TEST_SESSION)!
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)!
  const nativeId = head.handle.nativeId
  const codexHome = join(rig.root, 'codex-home')
  const sessionsDir = join(codexHome, 'sessions')
  await mkdir(sessionsDir, { recursive: true })
  const filePath = join(sessionsDir, 'readable.jsonl')
  await writeFile(
    filePath,
    `${[
      { type: 'session_meta', payload: { id: nativeId } },
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'terminal-turn' } },
      {
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'Readable before Codex is ready'
        }
      },
      { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'terminal-turn' } }
    ]
      .map((row) => JSON.stringify({ timestamp: '2026-10-26T12:00:00Z', ...row }))
      .join('\n')}\n`
  )
  // External lookup is the I/O boundary; import, journal, command and root stay real.
  vi.spyOn(cliTranscript, 'resolveStructuredChatCliSource').mockResolvedValue({
    host: rig.host,
    record,
    head,
    agent: 'codex',
    cwd: rig.root,
    providerSessionId: nativeId,
    metadata: structuredAgentRuntimeMetadata('codex')!,
    requireCurrent: () => {
      const current = rig.store.requireWritableRecord(record.sessionId)
      expect(current.location).toEqual(record.location)
      expect(agentSessionProviderHandleChainHead(current.providerHandleChain)?.linkId).toBe(
        head.linkId
      )
    }
  })
  vi.spyOn(cliTranscript, 'prepareStructuredChatCliTranscript').mockResolvedValue({
    useRealCodexHome: false,
    cliForkSource: {
      agent: 'codex',
      sourceAgent: 'codex',
      sessionId: nativeId,
      filePath,
      cwd: rig.root,
      codexHome,
      executionHostPlatform: process.platform
    }
  })
}
