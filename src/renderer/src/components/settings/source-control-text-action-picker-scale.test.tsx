// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'
import {
  getDefaultSourceControlAiSettings,
  normalizeSourceControlAiSettings
} from '../../../../shared/source-control-ai'
import { TooltipProvider } from '../ui/tooltip'
import { SourceControlTextActionAgentPicker } from './SourceControlTextActionAgentPicker'

const unused = vi.fn()
beforeEach(() => {
  useAppStore.setState({ settings: getDefaultSettings('/synthetic'), repos: [] })
})

it.each([5, 50])(
  'text cards pay no repository scan for unrelated publications with %s and 10x repos',
  async (size) => {
    const reads: Record<'global' | 'repo', number[]> = { global: [], repo: [] }
    for (const count of [size, size * 10]) {
      let idReads = 0
      const repos = Array.from({ length: count }, (_, index) => ({
        ...TEST_REPO,
        get id() {
          idReads += 1
          return `repo-${index}`
        }
      }))
      const source = normalizeSourceControlAiSettings({
        ...getDefaultSourceControlAiSettings(),
        enabled: true,
        agentId: 'codex'
      })
      useAppStore.setState({ repos })
      useAppStore.setState(({ settings }) => ({
        settings: settings && { ...settings, defaultTuiAgent: 'codex', sourceControlAi: source }
      }))
      const draft = { commandInputTemplate: '{basePrompt}', agentArgs: '' }
      const view = render(
        <TooltipProvider>
          <SourceControlTextActionAgentPicker
            actionId="commitMessage"
            agent="codex"
            source={source}
            draft={draft}
            onAgentChange={unused}
          />
          <SourceControlTextActionAgentPicker
            actionId="branchName"
            agent="codex"
            source={source}
            repoId={`repo-${count - 1}`}
            repoAi={{}}
            draft={draft}
            onAgentChange={unused}
          />
        </TooltipProvider>
      )
      const [globalCard, repoCard] = screen.getAllByRole('button', { name: 'Select agent' })
      idReads = 0
      act(() => useAppStore.setState({ settingsSearchQuery: `unrelated-${count}` }))
      const total = idReads
      // Only the repository card looks its repository up, once per publication.
      expect(total).toBeLessThanOrEqual(count)
      reads.repo.push(total)
      view.rerender(
        <TooltipProvider>
          <SourceControlTextActionAgentPicker
            actionId="commitMessage"
            agent="codex"
            source={source}
            draft={draft}
            onAgentChange={unused}
          />
        </TooltipProvider>
      )
      idReads = 0
      act(() => useAppStore.setState({ settingsSearchQuery: `unrelated-again-${count}` }))
      reads.global.push(idReads)
      const picked = normalizeSourceControlAiSettings({
        ...source,
        modelOverridesByOperation: { commitMessage: { selectedModelByAgent: { codex: 'gpt-5.4' } } }
      })
      view.rerender(
        <TooltipProvider>
          <SourceControlTextActionAgentPicker
            actionId="commitMessage"
            agent="codex"
            source={picked}
            draft={{ ...draft, modelChoice: picked.modelOverridesByOperation?.commitMessage }}
            onAgentChange={unused}
          />
        </TooltipProvider>
      )
      expect(globalCard.textContent).toContain('GPT-5.4')
      expect(repoCard.isConnected).toBe(false)
      view.unmount()
    }
    expect(reads.global).toEqual([0, 0])
    process.stdout.write(
      `${JSON.stringify({ metric: 'text-card-repo-id-reads-per-unrelated-publication', size, reads })}\n`
    )
  }
)
