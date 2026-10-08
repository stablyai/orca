// This build saves native chat statuses in `last-status.json` under a key of their own. The last
// release reads only the CLI agents' rows, so a downgrade must load that file as it always did:
// the CLI rows intact and the chat statuses ignored. Its quit drops them, so coming back up this
// build reads a file with no chat statuses at all, and its chats list until each is opened.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { AgentHookServer } from '../../../src/main/agent-hooks/server'
import { makePaneKey } from '../../../src/shared/stable-pane-id'
import { makeStructuredAgentStatusSubject } from '../../../src/shared/agent-status-subject'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

const RELEASE_REF = 'v1.4.222'
const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

type OlderHookServer = {
  start: (options: { env: string; userDataPath: string }) => Promise<void>
  stop: () => void
  getStatusSnapshot: () => { paneKey: string }[]
}

async function olderHookServer(): Promise<OlderHookServer> {
  const checkout = await materializeReleaseCheckout(RELEASE_REF)
  const module = await importReleaseCheckoutModule(checkout, 'src/main/agent-hooks/server.ts')
  const Server = module.AgentHookServer
  if (typeof Server !== 'function') {
    throw new Error(`${RELEASE_REF} exports no AgentHookServer`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the release's own hook server; each member read here is named in `OlderHookServer`, and a changed one fails the test.
  return new (Server as new () => OlderHookServer)()
}

test('the last release loads a file holding chat statuses, and this build loads what it writes', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-saved-chat-downgrade-'))
  const path = join(userDataPath, 'agent-hooks', 'last-status.json')
  const receivedAt = Date.now() - 60_000
  mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      entries: {
        [PANE]: {
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          receivedAt,
          stateStartedAt: receivedAt,
          payload: { state: 'done', prompt: 'a CLI agent', agentType: 'claude' }
        }
      }
    })
  )
  try {
    const current = new AgentHookServer()
    await current.start({ env: 'production', userDataPath })
    const chat = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    current.ingestStructuredStatus(
      {
        sessionId: chat,
        workspaceId: 'wt-1',
        agent: 'claude',
        status: 'working',
        latestPrompt: 'refactor the parser',
        updatedAt: receivedAt
      },
      makeStructuredAgentStatusSubject(
        {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'wt-1',
          workspaceKind: 'git-worktree'
        },
        chat
      )
    )
    current.stop()
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty([
      'structuredSessions',
      'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
    ])

    const older = await olderHookServer()
    await older.start({ env: 'production', userDataPath })
    expect(older.getStatusSnapshot().map((row) => row.paneKey)).toEqual([PANE])
    older.stop()
    const downgraded = JSON.parse(readFileSync(path, 'utf8'))
    expect(downgraded.version).toBe(2)
    expect(Object.keys(downgraded.entries)).toEqual([PANE])
    // Its quit rewrites the file without the key it never knew: the chats just list unsaved.
    expect(downgraded).not.toHaveProperty('structuredSessions')

    const upgraded = new AgentHookServer()
    await upgraded.start({ env: 'production', userDataPath })
    expect(upgraded.getStatusSnapshot().map((row) => row.paneKey)).toEqual([PANE])
    expect(upgraded.readSavedStructuredStatuses()).toEqual([])
    upgraded.stop()
  } finally {
    rmSync(userDataPath, { recursive: true, force: true })
  }
}, 180_000)
