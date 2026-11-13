import { defineFixture } from '../../component-fixtures/component-fixture'
import type { OrcaCloudGitHubRepository } from '@/lib/orca-cloud/use-orca-cloud-github-repositories'
import { cloudRepoKey, ProjectComboboxCloudSection } from './ProjectComboboxCloudSection'

const noop = (): void => {}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the section reads fullName and private only.
const repos = [
  { fullName: 'stablyai/orca', private: false },
  { fullName: 'stablyai/noqa', private: true },
  { fullName: 'nwparker/orca-private', private: true },
  { fullName: 'octocat/Hello-World', private: false }
] as OrcaCloudGitHubRepository[]

function section(options: { tooltip?: boolean; current?: string; unavailable?: boolean } = {}) {
  return defineFixture({
    width: 640,
    render: () => (
      // The picker's popover width, with room on the right for the badge's tooltip.
      <div className="bg-background p-3 pr-[17rem] pb-10">
        <div className="w-[22rem] rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md">
          <ProjectComboboxCloudSection
            repos={options.unavailable ? null : repos}
            value={options.current ? cloudRepoKey(options.current) : null}
            armedKey={null}
            armedId="armed"
            onArm={noop}
            onCommit={noop}
            showMoreAccess
            onRetry={noop}
          />
        </div>
      </div>
    ),
    ...(options.tooltip
      ? {
          interact: async (frame: HTMLElement) => {
            const badge = frame.querySelector('[data-cloud-only-badge]')
            badge?.dispatchEvent(
              new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
            )
            badge?.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
            await new Promise((resolve) => setTimeout(resolve, 900))
          }
        }
      : {})
  })
}

/** PROJ-MENU option A: "GitHub" header, one line per repository, lock when private, cloud badge. */
export const mixed = section({ current: 'stablyai/orca' })
export const badgeTooltip = section({ tooltip: true })
/** GH-LIST-MISSING: GitHub's list couldn't be read; the section stays, with Retry. */
export const unavailable = section({ unavailable: true })
