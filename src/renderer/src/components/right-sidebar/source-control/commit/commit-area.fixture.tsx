import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { CommitArea } from './commit-area'
import { resolveCommitAreaPrimaryAction } from '../review/source-control-primary-action'
import type { PrimaryActionInputs } from '../review/source-control-primary-action-types'
import { resolveDropdownItems } from '../panel/source-control-dropdown-items'

function PublishState({
  anotherWorkspace,
  publishing = true
}: {
  anotherWorkspace: boolean
  publishing?: boolean
}) {
  const inputs = {
    stagedCount: 0,
    hasUnstagedChanges: false,
    hasStageableChanges: false,
    hasPartiallyStagedChanges: false,
    hasMessage: false,
    hasUnresolvedConflicts: false,
    isCommitting: false,
    isRemoteOperationActive: publishing,
    isRemoteOperationInAnotherWorktree: anotherWorkspace,
    inFlightRemoteOpKind: publishing && !anotherWorkspace ? 'publish' : null,
    upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
  } satisfies PrimaryActionInputs
  const primaryAction = resolveCommitAreaPrimaryAction(inputs)
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
      isRemoteOperationActive={publishing}
      inFlightRemoteOpKind={inputs.inFlightRemoteOpKind}
      primaryAction={primaryAction}
      dropdownItems={resolveDropdownItems(inputs)}
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

export const actionDescriptions = defineFixture({
  width: 310,
  render: () => <PublishState anotherWorkspace={false} publishing={false} />,
  interact: (frame) => {
    frame
      .querySelector('button[aria-haspopup="menu"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
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
