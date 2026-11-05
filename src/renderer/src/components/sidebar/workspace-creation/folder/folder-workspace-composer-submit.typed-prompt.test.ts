// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeProjectGroup, makeFolderWorkspace } from './folder-workspace-composer-submit-fixtures'
import type * as NewWorkspaceModule from '@/lib/new-workspace'

const mocks = vi.hoisted(() => ({
  activateAndRevealFolderWorkspace: vi.fn(),
  ensureAgentStartupInTerminal: vi.fn()
}))

vi.mock('@/lib/worktree-activation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, activateAndRevealFolderWorkspace: mocks.activateAndRevealFolderWorkspace }
})

vi.mock('@/lib/new-workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof NewWorkspaceModule>()
  return { ...actual, ensureAgentStartupInTerminal: mocks.ensureAgentStartupInTerminal }
})

import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'

const linkedPr = {
  provider: 'github' as const,
  type: 'pr' as const,
  number: 91,
  title: 'Restore linked quick-create',
  url: 'https://github.com/stablyai/orca/pull/91',
  repoId: 'repo-1'
}

function submitWithTypedPrompt(
  typedPrompt: string,
  linkedWorkItem: typeof linkedPr | null,
  createFolderWorkspace = vi.fn(async () => makeFolderWorkspace()),
  note = ''
): Promise<boolean> {
  return submitFolderWorkspaceCreate({
    projectGroup: makeProjectGroup(),
    name: '',
    lastAutoName: '',
    linkedWorkItem,
    note,
    typedPrompt,
    quickAgent: 'codex',
    autoRenameBranchFromWork: true,
    agentCmdOverrides: {},
    createFolderWorkspace,
    onOpenChange: vi.fn()
  })
}

function startupCommand(): string {
  return mocks.activateAndRevealFolderWorkspace.mock.calls[0]?.[1]?.startup?.command ?? ''
}

describe('submitFolderWorkspaceCreate typed prompt', () => {
  beforeEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReturnValue({ primaryTabId: 'tab-1' })
  })

  afterEach(() => {
    mocks.activateAndRevealFolderWorkspace.mockReset()
    mocks.ensureAgentStartupInTerminal.mockReset()
  })

  it('auto-submits a typed prompt and marks the workspace for first-message rename', async () => {
    const createFolderWorkspace = vi.fn(async () => makeFolderWorkspace())

    await submitWithTypedPrompt('Fix the flaky checkout flow', null, createFolderWorkspace)

    expect(createFolderWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ pendingFirstAgentMessageRename: true })
    )
    expect(startupCommand()).toContain('Fix the flaky checkout flow')
  })

  it('auto-submits a typed prompt with the linked context appended', async () => {
    await submitWithTypedPrompt('Review the migration', linkedPr)

    expect(startupCommand()).toContain('Review the migration')
    expect(startupCommand()).toContain(linkedPr.url)
    expect(mocks.ensureAgentStartupInTerminal).not.toHaveBeenCalled()
  })

  it('keeps the note alongside a typed prompt when nothing is linked', async () => {
    await submitWithTypedPrompt(
      'Fix the flaky checkout flow',
      null,
      undefined,
      'Only touch the cart'
    )

    expect(startupCommand()).toContain('Fix the flaky checkout flow')
    expect(startupCommand()).toContain('Only touch the cart')
  })
})
