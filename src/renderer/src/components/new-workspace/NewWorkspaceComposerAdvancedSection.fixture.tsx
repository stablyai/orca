import { defineFixture } from '../../component-fixtures/component-fixture'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { NewWorkspaceComposerAdvancedSection } from './NewWorkspaceComposerAdvancedSection'
import { runOnHonoursParentWorktree } from './run-on/cloud-advanced-options'

const noop = (): void => {}

/** The Advanced section as the composer card renders it for a Run on (DS-j). */
function advanced(recipeId: string | null): React.JSX.Element {
  return (
    <div className="w-[460px] bg-background p-4">
      <NewWorkspaceComposerAdvancedSection
        advancedOpen
        setupChoiceRevealRequest={0}
        onSetupChoiceRevealed={noop}
        smartNameSelection={null}
        name="fix-flaky-checkout"
        onNameValueChange={noop}
        selectedRepoIsGit
        branchesEnabled
        canReuseSelectedBranch={false}
        branchNameOverride={undefined}
        onBranchNameOverrideChange={noop}
        parentWorktreeId={null}
        // Exactly what the card passes: no parent picker where the Run on can't take one.
        onParentWorktreeIdChange={runOnHonoursParentWorktree(recipeId) ? noop : undefined}
        selectedRepoExecutionHostId="local"
        selectedRepoProjectId={null}
        activeFolderWorkspaceId={null}
        note=""
        onNoteChange={noop}
        setupControlsEnabled={false}
        setupConfig={null}
        requiresExplicitSetupChoice={false}
        resolvedSetupDecision={null}
        onSetupDecisionChange={noop}
        setupAgentStartupPolicy="start-immediately"
        onSetupAgentStartupPolicyChange={noop}
        setupDecision={null}
        shouldWaitForSetupCheck={false}
        sparseControlsEnabled
        repoId="repo-1"
        sparsePresets={[]}
        sparseSelectedPresetId={null}
        onSparseSelectPreset={noop}
        canUseSparseCheckout
        onSparseEditingChange={noop}
        branchNameInputId="branch-name"
        showSetupAgentStartupPolicy={false}
      />
    </div>
  )
}

/** Run on this Mac: Parent worktree and Sparse/Full checkout. */
export const advancedLocal = defineFixture({ width: 500, render: () => advanced(null) })

/** DS-j, Run on Orca Cloud: no Parent row (a new sandbox can't nest under another host's
 * workspace); Sparse/Full checkout stays (the sandbox's worktree create honours it). */
export const advancedOrcaCloud = defineFixture({
  width: 500,
  render: () => advanced(ORCA_CLOUD_RECIPE_ID)
})
