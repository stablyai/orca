// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId, ExecutionHostScope } from '../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { AiVaultListResult } from '../../../shared/ai-vault-types'
import { useAppStore } from '@/store'
import { session, result } from '@/components/right-sidebar/ai-vault-structured-title-fixtures'
import { DEFAULT_AI_VAULT_SESSION_LIMIT } from '@/components/right-sidebar/ai-vault-session-limit'
import {
  resetAiVaultForcedRescanThrottleForTest,
  useAiVaultSessionRefresh
} from '@/components/right-sidebar/ai-vault-session-refresh'
import {
  applyStructuredSessionTabSnapshots,
  resetLocalStructuredSessionVersionForTests
} from './local-structured-session-tabs-sync'
import {
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch,
  resetWebSessionTabsSnapshotFreshnessForTests
} from './web-session-tabs-sync'
import { decideWebSessionTabsSnapshot } from './web-session-tabs-sync/tracking-decisions'

const initialState = useAppStore.getInitialState()
const workspaceId = 'folder:workspace'
const listSessions = vi.fn<() => Promise<AiVaultListResult>>()
let latest: ReturnType<typeof useAiVaultSessionRefresh> | undefined
let root: Root

function frame(version = 1, title = 'Saved after close'): RuntimeMobileSessionTabsResult {
  return {
    worktree: workspaceId,
    publicationEpoch: 'host:one',
    snapshotVersion: version,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [],
    structuredConversationTitle: { sessionId: 'native-session', agent: 'codex', title }
  }
}

function receive(
  host: 'local' | 'runtime:paired-host',
  snapshot: RuntimeMobileSessionTabsResult
): void {
  if (host === 'local') {
    applyStructuredSessionTabSnapshots([snapshot])
    return
  }
  const decision = decideWebSessionTabsSnapshot(snapshot, 'paired-host')
  applyWebSessionTabsStorePatch(
    (state) =>
      decision.apply ? applyWebSessionTabsSnapshot(state, snapshot, 'paired-host') : state,
    {
      frames: [{ environmentId: 'paired-host', worktreeId: snapshot.worktree, snapshot, decision }]
    },
    snapshot
  )()
}

function Probe({ scope }: { scope: ExecutionHostScope }): null {
  latest = useAiVaultSessionRefresh(['/folder'], scope, DEFAULT_AI_VAULT_SESSION_LIMIT)
  return null
}

async function render(visible = true, scope: ExecutionHostScope = 'local'): Promise<void> {
  await act(async () => {
    root.render(visible ? createElement(Probe, { scope }) : null)
  })
}

function prepare(host: ExecutionHostId): void {
  const row = { ...session(host), structuredSession: { workspaceId, sessionId: 'native-session' } }
  listSessions.mockResolvedValue(result(row))
  useAppStore.setState({
    folderWorkspaces: [
      {
        id: 'workspace',
        projectGroupId: 'group',
        name: 'Folder',
        folderPath: '/folder',
        executionHostId: host,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 1,
        createdAt: 1,
        updatedAt: 1
      }
    ]
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState(initialState, true)
  resetAiVaultForcedRescanThrottleForTest()
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  listSessions.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      aiVault: {
        listSessions,
        cancelListSessions: vi.fn().mockResolvedValue(undefined),
        onWindowFocused: () => () => {}
      }
    }
  })
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
  latest = undefined
})

describe.each(['local', 'runtime:paired-host'] as const)('%s saved-title receiver', (host) => {
  it('updates mounted and hidden-panel cached Vault rows after naming settles with no tab', async () => {
    prepare(host)
    await render(true, host)
    expect(latest?.sessions[0]?.title).toBe('Codex Chat')
    await act(async () => {
      receive(host, frame())
    })
    expect(latest?.sessions[0]?.title).toBe('Saved after close')
    await render(false, host)
    await act(async () => {
      receive(host, frame(2, 'Saved while hidden'))
    })
    await render(true, host)
    expect(latest?.sessions[0]?.title).toBe('Saved while hidden')
    expect(listSessions).toHaveBeenCalledTimes(1)
    expect(Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()).toHaveLength(0)
  })

  it('does not apply stale title frames or older-host frames lacking the optional field', async () => {
    prepare(host)
    await render(true, host)
    await act(async () => {
      receive(host, frame(2))
      receive(host, frame(1, 'Stale title'))
      const legacy = frame(3)
      delete legacy.structuredConversationTitle
      receive(host, legacy)
    })
    expect(latest?.sessions[0]?.title).toBe('Saved after close')
  })

  it.each([
    null,
    42,
    {},
    { sessionId: '', agent: 'codex', title: 'Invalid' },
    { sessionId: 'native-session', agent: 'unknown', title: 'Invalid' },
    { sessionId: 'native-session', agent: 'codex', title: 'line\nbreak' },
    { sessionId: 'native-session', agent: 'codex', title: 'x'.repeat(201) }
  ])('ignores malformed optional title data: %j', async (value) => {
    prepare(host)
    await render(true, host)
    const malformed = frame()
    Reflect.set(malformed, 'structuredConversationTitle', value)
    await act(async () => {
      receive(host, malformed)
    })
    expect(latest?.sessions[0]?.title).toBe('Codex Chat')
  })

  it('does not apply titles from another host, provider, workspace or native session', async () => {
    prepare('runtime:other-host')
    await render(true, 'all')
    await act(async () => {
      receive(host, frame())
    })
    expect(latest?.sessions[0]?.title).toBe('Codex Chat')
    prepare(host)
    await act(async () => {
      await latest?.refresh({ force: true })
    })
    await act(async () => {
      receive(host, {
        ...frame(2),
        structuredConversationTitle: {
          sessionId: 'native-session',
          agent: 'claude',
          title: 'Wrong provider'
        }
      })
      receive(host, { ...frame(3), worktree: 'folder:another-workspace' })
      receive(host, {
        ...frame(4),
        structuredConversationTitle: {
          sessionId: 'another-session',
          agent: 'codex',
          title: 'Wrong session'
        }
      })
    })
    expect(latest?.sessions[0]?.title).toBe('Codex Chat')
  })

  it.each([host, 'all'] as const)(
    'retains a title received during the initial pending %s list',
    async (scope) => {
      prepare(host)
      const scanned = result({
        ...session(host),
        structuredSession: { workspaceId, sessionId: 'native-session' }
      })
      let finish: (value: AiVaultListResult) => void = () => {
        throw new Error('Scan not initialized')
      }
      listSessions.mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve
        })
      )
      await render(true, scope)
      expect(latest?.scanResult).toBeNull()
      await act(async () => {
        receive(host, frame())
      })
      await act(async () => {
        finish(scanned)
      })
      expect(latest?.sessions[0]?.title).toBe('Saved after close')
      expect(listSessions).toHaveBeenCalledTimes(1)
    }
  )
})
