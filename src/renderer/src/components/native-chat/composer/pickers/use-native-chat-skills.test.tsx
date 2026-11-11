// @vitest-environment happy-dom
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { discoverSkills } from '../../../../../../main/skills/discovery/skill-native-discovery'
import type { SkillDiscoveryResult } from '../../../../../../shared/skills'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { useNativeChatSkills } from './use-native-chat-skills'

const rpc = vi.hoisted(() => ({ discover: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc.discover }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})

let home: string
let tabId: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'chat-skill-refresh-'))
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    folderWorkspaces: [makeFolderWorkspace({ id: 'skills', folderPath: home })]
  })
  tabId = useAppStore.getState().createUnifiedTab('folder:skills', 'agent-session', {
    agentSessionAgent: 'codex',
    executionHostId: 'local'
  }).id
  rpc.discover.mockReset().mockImplementation(readSkills)
})

afterEach(async () => {
  cleanup()
  await rm(home, { recursive: true, force: true })
})

function readSkills(): Promise<SkillDiscoveryResult> {
  return discoverSkills({ homeDir: home, cwd: home, refresh: true })
}

async function installSkill(): Promise<void> {
  const directory = join(home, '.agents', 'skills', 'installed-later')
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'SKILL.md'),
    '---\nname: installed-later\ndescription: A newly installed skill\n---\n'
  )
}

it('discovers a newly installed global skill when the same chat reopens its picker', async () => {
  const { result, rerender } = renderHook(
    (open: boolean) => useNativeChatSkills('codex', tabId, open),
    { initialProps: true }
  )
  await waitFor(() => expect(result.current.status).toBe('ready'))
  expect(result.current.skills).toEqual([])
  rerender(false)
  await installSkill()
  rerender(true)
  await waitFor(() =>
    expect(result.current.skills.map((skill) => skill.name)).toEqual(['installed-later'])
  )
})

it('does not restore a closed picker snapshot when its pending scan finishes', async () => {
  const scanned = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const pending = readSkills().then(async (answer) => {
    scanned.resolve()
    await release.promise
    return answer
  })
  rpc.discover.mockImplementationOnce(() => pending)
  const { result, rerender } = renderHook(
    (open: boolean) => useNativeChatSkills('codex', tabId, open),
    { initialProps: true }
  )
  try {
    await scanned.promise
    rerender(false)
    await installSkill()
    await act(async () => {
      release.resolve()
      await pending
    })
    rerender(true)
    await waitFor(() =>
      expect(result.current.skills.map((skill) => skill.name)).toEqual(['installed-later'])
    )
  } finally {
    release.resolve()
  }
})
