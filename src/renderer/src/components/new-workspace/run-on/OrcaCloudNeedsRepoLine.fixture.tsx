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
      <OrcaCloudNeedsRepoLine hasRepos onAddRepository={() => {}} />
    </Column>
  )
})
export const noGitHubRepositories = defineFixture({
  width: 260,
  render: () => (
    <Column>
      <OrcaCloudNeedsRepoLine hasRepos={false} onAddRepository={() => {}} />
    </Column>
  )
})
// Keyboard: the Add link shows its focus ring.
export const focused = defineFixture({
  ...noGitHubRepositories,
  interact: async (frame: HTMLElement) => {
    frame.querySelector<HTMLButtonElement>('button')?.focus()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})
