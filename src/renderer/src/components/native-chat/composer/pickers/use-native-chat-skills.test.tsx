// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DiscoveredSkill, SkillDiscoveryResult } from '../../../../../../shared/skills'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { useNativeChatSkills } from './use-native-chat-skills'

const rpc = vi.hoisted(() => ({ discover: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: rpc.discover }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})

const SKILLS_ROOT = '/home/user/.agents/skills'
let installed: string[]
let tabId: string

beforeEach(() => {
  installed = []
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    folderWorkspaces: [makeFolderWorkspace({ id: 'skills', folderPath: '/home/user/project' })]
  })
  tabId = useAppStore.getState().createUnifiedTab('folder:skills', 'agent-session', {
    agentSessionAgent: 'codex',
    executionHostId: 'local'
  }).id
  rpc.discover.mockReset().mockImplementation(async () => inventory())
})

afterEach(() => {
  cleanup()
})

function inventory(): SkillDiscoveryResult {
  const skills = installed.map((name): DiscoveredSkill => ({
    id: name,
    name,
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Shared',
    rootPath: SKILLS_ROOT,
    directoryPath: `${SKILLS_ROOT}/${name}`,
    skillFilePath: `${SKILLS_ROOT}/${name}/SKILL.md`,
    installed: true,
    updatedAt: null
  }))
  const source = {
    id: 'shared',
    label: 'Shared',
    path: SKILLS_ROOT,
    sourceKind: 'home' as const,
    providers: ['agent-skills' as const],
    owner: null,
    exists: true
  }
  return { skills, sources: [source], scannedAt: 0 }
}

it('discovers a newly installed global skill when the same chat reopens its picker', async () => {
  const { result, rerender } = renderHook(
    (open: boolean) => useNativeChatSkills('codex', tabId, open),
    { initialProps: true }
  )
  await waitFor(() => expect(result.current.status).toBe('ready'))
  expect(result.current.skills).toEqual([])
  rerender(false)
  installed.push('installed-later')
  rerender(true)
  // Reopening shows the last answer while the host is asked again, not a loading flash.
  expect(result.current.status).toBe('ready')
  await waitFor(() =>
    expect(result.current.skills.map((skill) => skill.name)).toEqual(['installed-later'])
  )
})

it('does not restore a closed picker snapshot when its pending scan finishes', async () => {
  const release = Promise.withResolvers<SkillDiscoveryResult>()
  rpc.discover.mockImplementationOnce(() => release.promise)
  const { result, rerender } = renderHook(
    (open: boolean) => useNativeChatSkills('codex', tabId, open),
    { initialProps: true }
  )
  const beforeInstall = inventory()
  rerender(false)
  installed.push('installed-later')
  await act(async () => {
    release.resolve(beforeInstall)
    await release.promise
  })
  rerender(true)
  await waitFor(() =>
    expect(result.current.skills.map((skill) => skill.name)).toEqual(['installed-later'])
  )
})
