import { useState } from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { NewWorkspaceComposerNameSection } from './NewWorkspaceComposerNameSection'
import type { EphemeralVmRecipeOption } from './run-target-options'

const orcaCloudRecipe: EphemeralVmRecipeOption = {
  id: 'cloud',
  name: 'Orca Cloud',
  description: 'Hosted by Orca. Sleeps when idle and keeps your files.',
  provider: 'orca-cloud',
  create: 'orca-cloud create'
}

function BranchReusePreview({
  busy = false,
  remote = true,
  initialReuse = true,
  initialBranchName,
  existingBranch = 'feature/nested',
  cloud = false
}: {
  busy?: boolean
  remote?: boolean
  initialReuse?: boolean
  initialBranchName?: string
  existingBranch?: string
  /** Run on is Orca Cloud: the branch choice is titled for a workspace, not a worktree. */
  cloud?: boolean
}) {
  const [reuse, setReuse] = useState(initialReuse)
  const [branchName, setBranchName] = useState<string | undefined>(initialBranchName)
  const [name, setName] = useState('Feature review')
  return (
    <div className="rounded-xl border border-border bg-background p-4">
      <NewWorkspaceComposerNameSection
        eligibleRepos={[]}
        repoId="repo"
        onRepoChange={() => {}}
        name={name}
        onNameValueChange={setName}
        onSmartGitHubItemSelect={() => {}}
        onSmartGitLabItemSelect={() => {}}
        onSmartBranchSelect={() => {}}
        onSmartLinearIssueSelect={() => {}}
        smartNameSelection={{
          kind: 'branch',
          label: remote ? `origin/${existingBranch}` : existingBranch
        }}
        onClearSmartNameSelection={() => {}}
        selectedRepoRequiresConnection={false}
        selectedRepoIsGit
        branchesEnabled
        forkPushWarning={null}
        branchNameOverride={branchName}
        onBranchNameOverrideChange={setBranchName}
        reuseEligibleBranch={existingBranch}
        canReuseSelectedBranch
        reuseSelectedBranch={reuse}
        onReuseSelectedBranchChange={(next) => {
          setReuse(next)
          setBranchName(undefined)
        }}
        onOpenSelectedBranchWorkspace={busy && reuse ? () => {} : undefined}
        baseBranch={
          remote ? `refs/remotes/origin/${existingBranch}` : `refs/heads/${existingBranch}`
        }
        ephemeralVmRecipes={cloud ? [orcaCloudRecipe] : []}
        selectedEphemeralVmRecipeId={cloud ? orcaCloudRecipe.id : null}
        onNamePlainEnter={() => {}}
      />
    </div>
  )
}

export const remoteBranch = defineFixture({ width: 480, render: () => <BranchReusePreview /> })
export const busyBranch = defineFixture({ width: 480, render: () => <BranchReusePreview busy /> })
export const narrow = defineFixture({
  width: 320,
  render: () => (
    <BranchReusePreview busy existingBranch="nwparker/perf-hosted-review-refs-early-reject" />
  )
})
export const localBranch = defineFixture({
  width: 480,
  render: () => <BranchReusePreview remote={false} />
})
export const newBranch = defineFixture({
  width: 480,
  render: () => <BranchReusePreview key="new-branch" initialReuse={false} />
})
export const namedNewBranch = defineFixture({
  width: 480,
  render: () => (
    <BranchReusePreview
      key="named-new"
      initialReuse={false}
      initialBranchName="feature/my-review"
    />
  )
})
export const orcaCloudRemoteBranch = defineFixture({
  width: 480,
  render: () => <BranchReusePreview cloud />
})
