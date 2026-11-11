import { defineFixture } from '../../../component-fixtures/component-fixture'
import { OrcaCloudNeedsRepoLine } from './OrcaCloudNeedsRepoLine'

// Under Project (half the composer, ~230px): Orca Cloud on a plain folder.
function Column({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="w-[230px] p-2">{children}</div>
}

export const withGitHubRepositories = defineFixture({
  width: 260,
  render: () => (
    <Column>
      <OrcaCloudNeedsRepoLine hasRepos onChooseRepository={() => {}} onAddRepository={() => {}} />
    </Column>
  )
})
export const noGitHubRepositories = defineFixture({
  width: 260,
  render: () => (
    <Column>
      <OrcaCloudNeedsRepoLine
        hasRepos={false}
        onChooseRepository={() => {}}
        onAddRepository={() => {}}
      />
    </Column>
  )
})
