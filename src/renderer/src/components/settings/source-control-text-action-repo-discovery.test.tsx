// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../shared/source-control-ai'
import type { SourceControlAiSettingsPatch } from '../../../../shared/source-control-ai-types'
import { TooltipProvider } from '../ui/tooltip'
import { SourceControlTextActionAgentPicker } from './SourceControlTextActionAgentPicker'

const discover = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-git-generation-client', () => ({
  discoverRuntimeCommitMessageModels: discover
}))

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
        sourceControlAi: normalizeSourceControlAiSettings(
          typeof patch === 'function' ? patch(settings.sourceControlAi!) : patch
        )
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

it('a local repository card lists the models this machine reports when its picker opens', async () => {
  useAppStore.setState({ repos: [TEST_REPO] })
  openRepoCard(TEST_REPO.id)
  expect(await screen.findByRole('option', { name: 'GPT-6.1 Sol' })).toBeDefined()
  expect(discover).toHaveBeenCalledWith(
    expect.objectContaining({ target: { kind: 'local' }, worktreeId: null }),
    'codex'
  )
  const saved = useAppStore.getState().settings?.sourceControlAi
  expect(saved?.discoveredModelsByAgentByHost?.local?.codex).toEqual(SOL)
})

it.each([
  { host: { connectionId: 'box' }, hostKey: 'ssh:box' },
  { host: { executionHostId: 'runtime:env-1' }, hostKey: 'runtime:env-1' }
])(
  'a remote repository card asks its host through one of its worktrees and saves under $hostKey',
  async ({ host, hostKey }) => {
    const repo = { ...TEST_REPO, id: 'remote', ...host }
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
