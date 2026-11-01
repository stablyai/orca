import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../src/shared/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../src/shared/agent-session-record'
import type { AiVaultChatForkSource } from '../../../src/shared/ai-vault-resume-preparation'
import { codexProviderHandle } from '../../../src/shared/agent-session-provider-handle-encoding'

/** A saved conversation for the real switch handler's account and transcript checks. */
export async function structuredSwitchSource(
  sessionId: string,
  workspaceId: string,
  thread: string
) {
  const root = await mkdtemp(join(tmpdir(), 'orca-cross-version-switch-'))
  const codexHome = join(root, 'codex-home')
  const sessions = join(codexHome, 'sessions')
  const filePath = join(sessions, `rollout-${thread}.jsonl`)
  await mkdir(sessions, { recursive: true })
  await writeFile(
    filePath,
    `${JSON.stringify({ type: 'session_meta', payload: { id: thread, cwd: root } })}\n`
  )
  const record: AgentSessionRecord = {
    ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId })),
    provider: 'codex',
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId,
      workspaceKind: 'git-worktree'
    },
    accountHome: { variable: 'CODEX_HOME', path: codexHome },
    launchDirectory: root,
    providerHandleChain: [
      {
        linkId: 'link-1',
        origin: 'created',
        mintedAtFence: 7,
        observedAt: 1_000,
        handle: codexProviderHandle(thread)
      }
    ]
  }
  const source: AiVaultChatForkSource = {
    agent: 'codex',
    sourceAgent: 'codex',
    sessionId: thread,
    cwd: root,
    codexHome,
    filePath,
    executionHostPlatform: process.platform
  }
  return { record, source, dispose: () => rm(root, { recursive: true, force: true }) }
}
