import { describe, expect, it } from 'vitest'
import {
  buildFolderWorkspaceLinkedStartupPlan,
  resolveFolderWorkspaceLaunchDraft
} from './folder-workspace-composer-submit'

const LINKED_ISSUE = {
  provider: 'github' as const,
  type: 'issue' as const,
  number: 42,
  title: 'Restore linked quick-create',
  url: 'https://github.com/stablyai/orca/issues/42',
  repoId: 'repo-1'
}

describe('buildFolderWorkspaceLinkedStartupPlan', () => {
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

describe('resolveFolderWorkspaceLaunchDraft', () => {
  it('drafts a typed prompt above the linked reference', () => {
    expect(
      resolveFolderWorkspaceLaunchDraft(LINKED_ISSUE, 'card note', 'ship the parser fix')
    ).toBe('ship the parser fix\n\ncard note\n\nhttps://github.com/stablyai/orca/issues/42')
  })

  it('keeps the note-only draft when no prompt is typed', () => {
    expect(resolveFolderWorkspaceLaunchDraft(LINKED_ISSUE, 'card note')).toBe(
      'card note\n\nhttps://github.com/stablyai/orca/issues/42'
    )
  })
})
