/**
 * Issue #8752 — Setup-script prompt remains visible after orca.yaml setup hook exists.
 *
 * Root cause (renderer invalidation, shared across OS — not Linux-only):
 * 1. SetupScriptPromptCard re-inspects only on activeRepo / inspectionRetryKey /
 *    isDismissed / settings / sidebarOpen — not on orca.yaml changes, runtime
 *    reconnect, or same-repo worktree activation.
 * 2. getRenderedSetupScriptPromptState keeps lastVisiblePrompt for the same
 *    project while promptState is null (pending), so a stale negative result
 *    continues to render across same-project worktree switches.
 *
 * Detection itself (hasEffectiveSetupCommand) correctly accepts shared
 * scripts.setup; the bug is stale UI state, not hook parsing.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/renderer/src/components/sidebar/repro-8752-setup-script-prompt-stale.test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasEffectiveSetupCommand } from '@/lib/setup-script-prompt'
import { getRenderedSetupScriptPromptState } from './setup-script-prompt-render-state'
import type { SetupScriptPromptInspection } from '@/lib/setup-script-prompt'
import type { HookCheckResult } from '@/runtime/runtime-hooks-client'
import type { Repo } from '../../../../../shared/types'

const cardSource = readFileSync(join(__dirname, 'SetupScriptPromptCard.tsx'), 'utf8')

function negativePrompt(repoId: string): SetupScriptPromptInspection {
  return {
    status: 'ok',
    repoId,
    hasEffectiveSetup: false,
    hasSharedHooks: false,
    candidate: null
  }
}

function positivePrompt(repoId: string): SetupScriptPromptInspection {
  return {
    status: 'ok',
    repoId,
    hasEffectiveSetup: true,
    hasSharedHooks: true,
    candidate: null
  }
}

describe('#8752 setup-script prompt stale after orca.yaml setup hook', () => {
  it('hasEffectiveSetupCommand accepts shared orca.yaml scripts.setup', () => {
    const repo = {
      id: 'repo-1',
      hookSettings: undefined
    } as Repo
    const hooksResult: HookCheckResult = {
      status: 'ok',
      hasHooks: true,
      hooks: { scripts: { setup: './scripts/setup-orca-worktree.sh' } },
      mayNeedUpdate: false
    }
    expect(hasEffectiveSetupCommand(repo, hooksResult)).toBe(true)
  })

  it('inspection effect deps omit orca.yaml / runtime / same-repo worktree signals', () => {
    // The bug: only these five deps re-run inspection.
    expect(cardSource).toMatch(
      /\[activeRepo, inspectionRetryKey, isDismissed, settings, sidebarOpen\]/
    )
    // No invalidation from filesystem or runtime generation
    expect(cardSource).not.toMatch(/orca\.yaml/)
    expect(cardSource).not.toMatch(/runtimeGeneration|runtimeReconnect|hooksChanged/)
  })

  it('retains last-visible negative prompt while same-project re-inspection is pending', () => {
    const staleNegative = negativePrompt('repo-primary')
    const rendered = getRenderedSetupScriptPromptState({
      promptState: null, // mid-inspection after worktree switch
      activeRepoId: 'repo-worktree',
      activeProjectId: 'github:org/repo',
      lastVisiblePrompt: { state: staleNegative, projectId: 'github:org/repo' }
    })
    // Bug: stale "Add a setup script" stays on screen even if hooks now exist
    expect(rendered).toBe(staleNegative)
    expect(rendered?.hasEffectiveSetup).toBe(false)
  })

  it('would hide the prompt only after a fresh positive inspection lands', () => {
    const fresh = positivePrompt('repo-worktree')
    expect(
      getRenderedSetupScriptPromptState({
        promptState: fresh,
        activeRepoId: 'repo-worktree',
        activeProjectId: 'github:org/repo',
        lastVisiblePrompt: {
          state: negativePrompt('repo-primary'),
          projectId: 'github:org/repo'
        }
      })
    ).toEqual(fresh)
  })
})
