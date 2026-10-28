import { describe, expect, it } from 'vitest'
import {
  buildFolderWorkspaceLinkedStartupPlan,
  resolveFolderWorkspaceLaunchDraft
} from './folder-workspace-agent-startup'

describe('buildFolderWorkspaceLinkedStartupPlan', () => {
  it('keeps a custom task prompt as an unsent folder-workspace draft', () => {
    const linkedWorkItem = {
      provider: 'jira' as const,
      type: 'issue' as const,
      number: 0,
      title: 'Fix launch',
      url: 'https://example.atlassian.net/browse/PROJ-123'
    }
    const promptTemplate = '{{url}} /jira-engineer'
    const expected = `Read first\n\n${linkedWorkItem.url} /jira-engineer`
    const plan = buildFolderWorkspaceLinkedStartupPlan({
      agent: 'hermes',
      linkedWorkItem,
      note: 'Read first',
      promptTemplate,
      agentCmdOverrides: {},
      platform: 'linux',
      isRemote: true
    })
    expect(plan?.draftPrompt).toBe(expected)
    expect(plan?.followupPrompt).toBeNull()
    expect(resolveFolderWorkspaceLaunchDraft(linkedWorkItem, 'Read first', promptTemplate)).toBe(
      expected
    )
  })
  it('uses cmd quoting for configured arguments on local Windows', () => {
    const plan = buildFolderWorkspaceLinkedStartupPlan({
      agent: 'hermes',
      linkedWorkItem: {
        provider: 'github',
        type: 'issue',
        number: 42,
        title: 'Restore linked quick-create',
        url: 'https://github.com/stablyai/orca/issues/42',
        repoId: 'repo-1'
      },
      note: '',
      agentCmdOverrides: {},
      agentArgs: '--provider "value with space"',
      platform: 'win32',
      shell: 'cmd',
      isRemote: false
    })

    expect(plan?.launchCommand).toBe('hermes --tui "--provider" "value with space"')
  })
})
