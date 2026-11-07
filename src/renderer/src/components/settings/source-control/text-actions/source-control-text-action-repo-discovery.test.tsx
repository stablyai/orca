// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type * as GenerationClient from '@/runtime/source-control/git/runtime-git-generation-client'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { getDefaultSettings } from '../../../../../../shared/constants'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import type { SourceControlAiSettingsPatch } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { TooltipProvider } from '../../../ui/tooltip'
import { SourceControlTextActionAgentPicker } from './SourceControlTextActionAgentPicker'

const discover = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/source-control/git/runtime-git-generation-client', () => ({
  discoverRuntimeCommitMessageModels: discover
}))
// The WSL case runs the real client; loaded at collection, outside any test's timeout.
const actualGenerationClient = await vi.importActual<typeof GenerationClient>(
  '@/runtime/source-control/git/runtime-git-generation-client'
)

const SOL = [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }]

beforeEach(() => {
  discover.mockReset()
  discover.mockResolvedValue({ success: true, models: SOL })
  useAppStore.setState({
    settings: getDefaultSettings('/synthetic'),
    repos: [],
    worktreesByRepo: {}
  })
})
afterEach(() => vi.unstubAllGlobals())

function openRepoCard(repoId: string) {
  useAppStore.setState(({ settings }) => ({
    settings: settings && {
      ...settings,
      sourceControlAi: normalizeSourceControlAiSettings({
        ...getDefaultSourceControlAiSettings(),
        enabled: true,
        agentId: 'codex'
      })
    }
  }))
  const write = vi.fn(async (patch: SourceControlAiSettingsPatch) => {
    useAppStore.setState(({ settings }) => ({
      settings: settings && {
        ...settings,
        sourceControlAi: normalizeSourceControlAiSettings({
          ...settings.sourceControlAi!,
          ...(typeof patch === 'function' ? patch(settings.sourceControlAi!) : patch)
        })
      }
    }))
  })
  // The settings page passes the saved settings down, so a saved listing reaches the menu.
  function Card() {
    const source = useAppStore((state) => state.settings?.sourceControlAi)!
    return (
      <SourceControlTextActionAgentPicker
        actionId="commitMessage"
        agent="codex"
        source={source}
        repoId={repoId}
        repoAi={{}}
        draft={{ commandInputTemplate: '{basePrompt}', agentArgs: '' }}
        onAgentChange={vi.fn()}
        writeSourceControlAiSettings={write}
      />
    )
  }
  render(
    <TooltipProvider>
      <Card />
    </TooltipProvider>
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Select agent' }), { button: 0 })
  fireEvent.click(screen.getByRole('button', { name: 'Configure Codex' }))
}

it('a local repository card in WSL refreshes the local catalog generation reads, as the global card does', async () => {
  discover.mockImplementation(actualGenerationClient.discoverRuntimeCommitMessageModels)
  const list = vi.fn(async (args: { worktreePath?: string }) => ({
    success: true,
    models: args.worktreePath ? [{ id: 'wsl-only', label: 'WSL only' }] : SOL
  }))
  vi.stubGlobal('api', { git: { discoverCommitMessageModels: list } })
  const path = String.raw`\\wsl.localhost\Ubuntu\home\me\repo`
  const repo: Repo = { ...TEST_REPO, path, executionHostId: 'local' }
  const worktree = makeWorktree({ id: `${repo.id}::${path}`, repoId: repo.id, path })
  useAppStore.setState({ repos: [repo], worktreesByRepo: { [repo.id]: [worktree] } })
  openRepoCard(repo.id)
  expect(await screen.findByRole('option', { name: 'GPT-6.1 Sol' })).toBeDefined()
  expect(screen.queryByRole('option', { name: 'WSL only' })).toBeNull()
  expect(list).toHaveBeenCalledExactlyOnceWith({
    agentId: 'codex',
    worktreePath: '',
    connectionId: undefined
  })
  expect(useAppStore.getState().settings?.sourceControlAi?.discoveredModelsByAgentByHost).toEqual({
    local: { codex: SOL }
  })
})

it.each<{ host: Pick<Repo, 'connectionId' | 'executionHostId'>; hostKey: string }>([
  { host: { connectionId: 'box' }, hostKey: 'ssh:box' },
  { host: { executionHostId: 'runtime:env-1' }, hostKey: 'runtime:env-1' }
])(
  'a remote repository card asks its host through one of its worktrees and saves under $hostKey',
  async ({ host, hostKey }) => {
    const repo: Repo = { ...TEST_REPO, id: 'remote', ...host }
    const worktree = makeWorktree({ id: 'remote::/srv/app', repoId: 'remote', path: '/srv/app' })
    useAppStore.setState({ repos: [repo], worktreesByRepo: { remote: [worktree] } })
    openRepoCard('remote')
    await waitFor(() =>
      expect(
        useAppStore.getState().settings?.sourceControlAi?.discoveredModelsByAgentByHost
      ).toEqual({ [hostKey]: { codex: SOL } })
    )
    expect(discover).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: worktree.id, worktreePath: '/srv/app' }),
      'codex'
    )
  }
)
