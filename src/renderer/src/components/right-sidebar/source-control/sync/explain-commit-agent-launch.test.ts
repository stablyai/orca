import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SourceControlAgentLaunchModule from '@/lib/source-control-agent-launch'

const mocks = vi.hoisted(() => ({
  launchSourceControlAgent: vi.fn(),
  launchAgentInNewTab: vi.fn()
}))

vi.mock('@/lib/source-control-agent-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof SourceControlAgentLaunchModule>()),
  launchSourceControlAgent: mocks.launchSourceControlAgent
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launchAgentInNewTab }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn(), message: vi.fn() } }))
vi.mock('@/lib/agent-launch-prompt-not-delivered-notice', () => ({
  showAgentLaunchPromptNotDeliveredNotice: vi.fn()
}))

import { launchExplainCommitAgent } from './use-git-history-commit-actions'

const PROMPT = 'Explain the changes introduced by commit abc123.\nSubject: "fix"'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('explaining a commit', () => {
  it('asks the host for the default agent under the explain-commit launch source', async () => {
    mocks.launchSourceControlAgent.mockResolvedValue({ kind: 'launched', promptDelivered: true })

    await launchExplainCommitAgent('codex', 'wt-1', PROMPT)

    expect(mocks.launchSourceControlAgent).toHaveBeenCalledWith({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: PROMPT,
      launchSource: 'explain_commit'
    })
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
  })

  it('attributes the tab-paste fallback to explain-commit too, not the tab bar', async () => {
    mocks.launchSourceControlAgent.mockResolvedValue({ kind: 'unsupported' })

    await launchExplainCommitAgent('codex', 'wt-1', PROMPT)

    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith({
      agent: 'codex',
      worktreeId: 'wt-1',
      prompt: PROMPT,
      promptDelivery: 'submit-after-ready',
      launchSource: 'explain_commit'
    })
  })
})
