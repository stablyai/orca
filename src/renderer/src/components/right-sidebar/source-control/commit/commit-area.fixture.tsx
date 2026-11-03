import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { CommitArea } from './commit-area'
import { resolveCommitAreaPrimaryAction } from '../../source-control-primary-action'

function PublishState({ anotherWorkspace }: { anotherWorkspace: boolean }) {
  const primaryAction = resolveCommitAreaPrimaryAction({
    stagedCount: 0,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
    hasPartiallyStagedChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: true,
    isRemoteOperationInAnotherWorktree: anotherWorkspace,
    inFlightRemoteOpKind: anotherWorkspace ? null : 'publish',
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
  })
  return (
    <CommitArea
      worktreeId="fixture-workspace"
      groupId={null}
      commitMessage=""
      commitError={null}
      commitFailureRecoveryPrompt={null}
      pushRecovery={null}
      remoteActionError={null}
      isCommitting={false}
      isFixingCommitFailureWithAI={false}
      isFixingPushFailureWithAI={false}
      sourceControlAiActionsVisible={false}
      aiAgentConfigured={false}
      isGenerating={false}
      generateError={null}
      stagedCount={0}
      hasPartiallyStagedChanges={false}
      hasUnresolvedConflicts={false}
      isRemoteOperationActive
      inFlightRemoteOpKind={anotherWorkspace ? null : 'publish'}
      primaryAction={primaryAction}
      dropdownItems={[]}
      onCommitMessageChange={() => {}}
      onGenerate={() => {}}
      onCancelGenerate={() => {}}
      onFixCommitFailureWithAI={() => false}
      onFixPushFailureWithAI={() => false}
      onPrimaryAction={() => {}}
      onDropdownAction={() => {}}
    />
  )
}

export const anotherWorkspacePublishing = defineFixture({
  width: 310,
  render: () => <PublishState anotherWorkspace />
})

export const thisWorkspacePublishing = defineFixture({
  width: 310,
  render: () => <PublishState anotherWorkspace={false} />
})

export const anotherWorkspacePublishingTooltip = defineFixture({
  width: 310,
  render: () => <PublishState anotherWorkspace />,
  interact: (frame) => {
    frame.querySelector<HTMLElement>('span[tabindex="0"]')?.focus()
  }
})

export const narrowAnotherWorkspacePublishing = defineFixture({
  ...anotherWorkspacePublishing,
  width: 220,
  interact: (frame) => {
    const container = frame.querySelector('.px-3')
    if (container && container.scrollWidth > container.clientWidth) {
      throw new Error('Commit actions overflow the minimum sidebar width')
    }
  }
})

export const narrowAnotherWorkspacePublishingTooltip = defineFixture({
  ...anotherWorkspacePublishingTooltip,
  width: 220
})
