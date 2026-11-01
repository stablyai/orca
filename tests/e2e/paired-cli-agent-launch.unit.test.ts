import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../../src/cli/runtime/client'
import type { AgentLaunchResult } from '../../src/shared/agent-launch-intent'
import { openTestAgentSessionRecordStore } from '../../src/main/runtime/agent-session-record-store-test-harness'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../src/main/runtime/runtime-rpc'
import {
  runtimeStub,
  setAgentLaunchRecordStore
} from '../../src/main/runtime/rpc/methods/agent-launch.test-fixture'
import { AGENT_LAUNCH_METHODS } from '../../src/main/runtime/rpc/methods/agent-launch'
import { STATUS_METHODS } from '../../src/main/runtime/rpc/methods/status'
import { closeTestJournalHostDatabase } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'

const TARGETS = [
  { kind: 'existing', worktree: 'id:wt-7' },
  { kind: 'create-worktree', create: { repo: 'id:repo-1', name: 'paired-task' } },
  { kind: 'create-folder-workspace', create: { projectGroupId: 'group-1' } }
] as const

describe.each([
  { method: 'agent.launch', path: 'preflight' },
  { method: 'agent.launch', path: 'verified-status' },
  { method: 'agent.launchReplay', path: 'preflight' },
  { method: 'agent.launchReplay', path: 'verified-status' }
])('paired CLI $method via $path', ({ method, path }) => {
  it.each(TARGETS)('launches and replays $kind without a second agent', async (target) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-paired-cli-launch-'))
    const store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)
    const boundary = runtimeStub({
      settings: {},
      terminalPaneKey: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      startupTerminalPaneKey:
        '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      lineCarriesPrompt: true
    })
    const runtime = Object.assign(new OrcaRuntimeService(), boundary, {
      selectCreatedMobileSessionTabForClient: vi.fn(() => true)
    })
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath: directory,
      methods: [...STATUS_METHODS, ...AGENT_LAUNCH_METHODS],
      enableWebSocket: true,
      wsPort: 0
    })
    try {
      await server.start()
      const offer = server.createPairingOffer({ name: 'paired-cli', scope: 'runtime' })
      if (!offer.available) {
        throw new Error('pairing unavailable')
      }
      const client = new RuntimeClient(directory, 5_000, offer.pairingUrl, null)
      if (path === 'verified-status') {
        await client.getCliStatus()
      }
      const params = {
        agent: 'claude',
        target,
        presentation: 'background',
        operationId: `${Date.now()}-000000000000000000000000000000ef`,
        prompt: { text: 'Reply with OK', delivery: 'submit' }
      }
      const first = await client.call<AgentLaunchResult>(method, params)
      expect(first.result).toMatchObject({
        outcome: { kind: 'terminal' },
        worktreeId:
          target.kind === 'existing'
            ? 'wt-7'
            : target.kind === 'create-worktree'
              ? 'wt-new'
              : 'folder:fw-new',
        prompt: { delivery: 'submit', outcome: 'handed-to-terminal' }
      })
      const replay = await client.call<AgentLaunchResult>(method, params)
      expect(replay.result).toEqual(first.result)
      if (target.kind === 'create-worktree') {
        expect(boundary.createManagedWorktree).toHaveBeenCalledTimes(1)
        expect(boundary.createTerminal).not.toHaveBeenCalled()
      } else {
        expect(boundary.createTerminal).toHaveBeenCalledTimes(1)
        expect(boundary.createTerminal).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ startupAgent: 'claude', startupPrompt: 'Reply with OK' })
        )
      }
      expect(boundary.createFolderWorkspace).toHaveBeenCalledTimes(
        target.kind === 'create-folder-workspace' ? 1 : 0
      )
    } finally {
      await server.stop()
      setAgentLaunchRecordStore(null)
      await closeTestJournalHostDatabase(directory)
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
