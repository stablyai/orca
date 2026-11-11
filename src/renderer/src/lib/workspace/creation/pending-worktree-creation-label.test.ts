import { expect, it } from 'vitest'
import {
  getCreationProgressLabel,
  type PendingWorktreeCreation,
  type WorktreeCreationRequest
} from './pending-worktree-creation'
import type { Translate } from '@/i18n/use-translate'

const t: Translate = (_key, fallback) => fallback

function request(overrides: Partial<WorktreeCreationRequest> = {}): WorktreeCreationRequest {
  return {
    repoId: 'r',
    name: 'fix-login',
    setupDecision: 'skip',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    ...overrides
  }
}

function label(
  provider: 'orca-cloud' | undefined,
  environmentCheck?: PendingWorktreeCreation['environmentCheck']
): string {
  return getCreationProgressLabel(
    {
      status: 'creating',
      phase: 'provisioning-vm',
      indeterminate: false,
      environmentCheck,
      request: request({
        ephemeralVmRecipe: { sourceRepoId: 'r', recipeId: 'cloud', projectId: 'p', provider }
      })
    },
    t
  )
}

it('speaks of a sandbox for Orca Cloud and keeps VM wording for bring-your-own recipes', () => {
  expect(label('orca-cloud')).toBe('Starting sandbox…')
  expect(label('orca-cloud', { status: 'running', startedAt: 1 })).toBe('Preparing environment…')
  expect(label(undefined)).toBe('Provisioning VM…')
})

it('the Orca Cloud sidebar line follows the clone step', () => {
  const at = (provisioningLog: string) =>
    getCreationProgressLabel(
      {
        status: 'creating',
        phase: 'provisioning-vm',
        indeterminate: false,
        provisioningLog,
        request: request({
          ephemeralVmRecipe: {
            sourceRepoId: 'r',
            recipeId: 'cloud',
            projectId: 'p',
            provider: 'orca-cloud'
          }
        })
      },
      t
    )
  expect(at('[orca-cloud] provisioning\n')).toBe('Starting sandbox…')
  expect(at('[orca-cloud] cloning\n[orca-cloud] clone-progress 40 download\n')).toBe(
    'Cloning the repository…'
  )
  expect(at('[orca-cloud] cloning\n[orca-cloud] connecting\n')).toBe('Preparing environment…')
})
