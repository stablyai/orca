// COPY-LINK-RULE on the build sheet: "How to push to GitHub" as a split button (its chevron menu
// open), and "Copy support link" right below "Contact support" in the More menu.
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  CLOUD_RECIPE,
  FAILED_LOG,
  T0,
  entry,
  seedFixtureRepo,
  sheet
} from './vm-build-sheet-fixture-support'

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120))

// Radix menus open on pointerdown, not click.
function openMenu(selector: string) {
  return async (frame: HTMLElement): Promise<void> => {
    frame
      .querySelector<HTMLButtonElement>(selector)
      ?.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      )
    await settle()
  }
}

function failed(errorCode: string, error: string, log: string) {
  return {
    value: entry(
      { status: 'error', errorCode, provisioningLog: log, errorAt: T0 + 2_000 },
      CLOUD_RECIPE
    ),
    error
  }
}

const noRemote = failed(
  'cloudNoGithubRemote',
  'Orca Cloud clones your code from GitHub, and this repository has no GitHub remote.',
  ''
)
const snapshot = failed('recipeExited', 'Recipe exited with code 1.', FAILED_LOG)

/** "How to push to GitHub" with its chevron open: Copy link. */
export const pushToGitHubCopyLink = defineFixture({
  width: 760,
  setup: () => seedFixtureRepo(null),
  render: () => sheet(noRemote.value, noRemote.error, T0 + 2_000),
  interact: openMenu('button[aria-label="More link options"]')
})

/** "Contact support" in More, with "Copy support link" right below it. */
export const contactSupportCopyLink = defineFixture({
  width: 760,
  setup: () => seedFixtureRepo(),
  render: () => sheet(snapshot.value, snapshot.error, T0 + 2_000),
  interact: openMenu('[data-vm-build-sheet] button[aria-haspopup="menu"]')
})
