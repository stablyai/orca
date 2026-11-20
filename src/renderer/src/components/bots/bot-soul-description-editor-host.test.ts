// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callRuntimeRpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc }))

import type { HostAuthority } from '../../../../shared/execution-host/host-authority'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '@/components/editor/autosave/editor-autosave'
import { setBotHostListing } from '@/lib/bot-catalog-snapshot'
import type { EditorFileOperationProvenance } from '@/lib/editor/file-operations/editor-file-operation-provenance'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { makeOpenFile } from '@/store/slices/editor/types/open-file.test-fixture'
import type { BotHome } from '../settings/bots/bot-home-files'
import { useBotSoulDescription } from './bot-soul-description'

// Which editor saves a bot's purpose takes: only its own SOUL.md on its own filesystem. The same
// path on another paired server, on an SSH machine reached from here, or on an SSH machine reached
// through the bot's own server is another file.

const soul = (purpose: string): string => `# CoS\n\n${purpose}\n`
const PATH = '/bots/cos/SOUL.md'
const homes = {
  local: { bot: { hostId: 'local', folderWorkspaceId: 'fw-cos' }, folderPath: '/bots/cos' },
  paired: { bot: { hostId: 'runtime:env-1', folderWorkspaceId: 'fw-cos' }, folderPath: '/bots/cos' }
} satisfies Record<string, BotHome>
const FIRST = { local: 'On this computer', paired: 'On the server' }

/** Where a tab says it opened: its server (null for this app) and the machine there. */
function provenance(
  runtimeEnvironmentId: string | null,
  at: HostAuthority['at']
): EditorFileOperationProvenance {
  return {
    ownershipProjection: 'qualified',
    generation: {
      route: {
        executionHostId:
          at === 'local' && runtimeEnvironmentId ? `runtime:${runtimeEnvironmentId}` : at,
        runtimeEnvironmentId
      },
      authority: {
        endpoint: runtimeEnvironmentId
          ? { kind: 'environment', environmentId: runtimeEnvironmentId }
          : { kind: 'self' },
        at
      },
      runtimeConnectionGeneration: null,
      runtimePairingRevision: undefined,
      runtimeSshGeneration: null,
      nestedSshGeneration: null,
      directSshGeneration: null
    }
  }
}

type Tab = Partial<OpenFile> & Pick<OpenFile, 'runtimeEnvironmentId'>
const tabs = {
  // "Open as file" on a local bot: the bot's folder workspace on this app.
  localOpenAsFile: { runtimeEnvironmentId: null },
  localWithProvenance: {
    runtimeEnvironmentId: null,
    operationProvenance: provenance(null, 'local')
  },
  // "Open as file" on a paired bot: stamped with its server.
  pairedOpenAsFile: { runtimeEnvironmentId: 'env-1' },
  pairedWithProvenance: {
    runtimeEnvironmentId: 'env-1',
    operationProvenance: provenance('env-1', 'local')
  },
  // An SSH machine dialled from this app.
  directSsh: {
    runtimeEnvironmentId: null,
    externalSshTargetId: 'ssh-one',
    operationProvenance: provenance(null, 'ssh:ssh-one')
  },
  // An older direct SSH tab that recorded only its SSH target.
  directSshTargetOnly: { runtimeEnvironmentId: null, externalSshTargetId: 'ssh-one' },
  // An SSH machine reached through the paired server.
  nestedSsh: {
    runtimeEnvironmentId: 'env-1',
    operationProvenance: provenance('env-1', 'ssh:ssh-one')
  }
} satisfies Record<string, Tab>

const readFile = vi.fn()

beforeEach(() => {
  readFile.mockReset().mockResolvedValue({ content: soul(FIRST.local) })
  callRuntimeRpc.mockReset().mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'status.get') {
      return createCompatibleRuntimeStatusResponse('env-1').result
    }
    return method === 'files.read' ? { content: soul(FIRST.paired) } : { ok: true }
  })
  vi.stubGlobal('api', { fs: { readFile, writeFile: vi.fn() } })
  setBotHostListing({
    hosts: [
      { hostId: 'local', state: 'live' },
      { hostId: 'runtime:env-1', state: 'live' }
    ],
    updateNeeded: []
  })
  useAppStore.setState({ openFiles: [] })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function saveInTab(
  bot: keyof typeof homes,
  tab: Tab,
  filePath = PATH
): Promise<string | null> {
  const { result } = renderHook(() => useBotSoulDescription(homes[bot]))
  await waitFor(() => expect(result.current).toBe(FIRST[bot]))
  act(() => {
    useAppStore.setState({
      openFiles: [
        makeOpenFile({
          ...tab,
          id: 'soul-tab',
          worktreeId: 'folder:fw-cos',
          filePath,
          relativePath: 'SOUL.md'
        })
      ]
    })
    window.dispatchEvent(
      new CustomEvent(ORCA_EDITOR_FILE_SAVED_EVENT, {
        detail: {
          fileId: 'soul-tab',
          content: soul('Saved in the tab'),
          recordViewIds: ['soul-tab']
        }
      })
    )
  })
  return result.current
}

describe('useBotSoulDescription editor saves by filesystem', () => {
  it.each([
    ['local', 'localOpenAsFile'],
    ['local', 'localWithProvenance'],
    ['paired', 'pairedOpenAsFile'],
    ['paired', 'pairedWithProvenance']
  ] as const)('a %s bot takes a save from its own SOUL.md tab (%s)', async (bot, tab) => {
    expect(await saveInTab(bot, tabs[tab])).toBe('Saved in the tab')
  })

  it.each([
    ['local', 'directSsh'],
    ['local', 'directSshTargetOnly'],
    ['local', 'nestedSsh'],
    ['paired', 'directSsh'],
    ['paired', 'nestedSsh']
  ] as const)('a %s bot ignores the same path saved over SSH (%s)', async (bot, tab) => {
    // In the bot's own folder workspace too, so only the filesystem tells them apart.
    expect(await saveInTab(bot, tabs[tab])).toBe(FIRST[bot])
  })

  it.each([
    ['local', 'pairedOpenAsFile'],
    ['local', 'pairedWithProvenance'],
    ['paired', 'localOpenAsFile'],
    ['paired', 'localWithProvenance']
  ] as const)('a %s bot ignores the same path on the other endpoint (%s)', async (bot, tab) => {
    expect(await saveInTab(bot, tabs[tab])).toBe(FIRST[bot])
  })

  it('ignores another file on the bot’s own filesystem', async () => {
    expect(await saveInTab('local', tabs.localWithProvenance, '/bots/cos/MEMORY.md')).toBe(
      FIRST.local
    )
  })
})
