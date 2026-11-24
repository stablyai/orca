import { defineFixture } from '../../../component-fixtures/component-fixture'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import {
  now,
  hour,
  FAILING,
  LOADING,
  STALE_CHECKS,
  pr,
  LINKS,
  store,
  linkBlock,
  narrowLinkBlock,
  rowButton,
  sampleBot,
  hover,
  hoverElement,
  signedIn,
  PaneProbe,
  wait,
  escape
} from './bot-item-link-peeks-fixture'

/** Hovering an open PR row whose checks fail: the GitHub card, not the text tooltip. */
export const hoverOpenPr = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => linkBlock(),
  interact: (frame) => hover(frame, 'Share dialog: view-only links')
})

export const hoverMergedPr = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => linkBlock(),
  interact: (frame) => hover(frame, 'Share dialog scaffolding')
})

export const hoverIssue = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => linkBlock(),
  interact: (frame) => hover(frame, 'Share links open as editable')
})

/** Tab onto a row: the same card opens. */
export const keyboardFocus = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => linkBlock(),
  interact: async (frame) => {
    rowButton(frame, 'Share dialog: view-only links').focus()
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
})

/** A narrow item pane: the row still truncates and the card stays inside the window. */
export const narrowPane = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => narrowLinkBlock(),
  interact: (frame) => hover(frame, 'Share dialog: view-only links')
})

/** An open PR with passing checks. */
export const hoverPassingPr = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () =>
    linkBlock([
      pr(41236, 'open', 'success', 'Share link API with expiring tokens'),
      pr(41230, 'open', 'failure', 'Share dialog: view-only links by default')
    ]),
  interact: (frame) => hover(frame, 'Share link API')
})

/** While the lookup runs: what the row knows, not a skeleton. */
export const lookupLoading = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => linkBlock([pr(LOADING, 'open', 'pending', 'Share dialog analytics events')]),
  interact: (frame) => hover(frame, 'Share dialog analytics events')
})

/** The lookup fails: the card says what the row knows (title, state, checks, repo). */
export const lookupFails = defineFixture({
  width: 720,
  store,
  setup: signedIn('fail'),
  render: () => linkBlock([pr(FAILING, 'open', 'pending', 'Share dialog keyboard shortcuts')]),
  interact: (frame) => hover(frame, 'Share dialog keyboard shortcuts')
})

/** A GitHub row revealed by expanding the Links block still previews on hover. */
export const overflowRow = defineFixture({
  width: 420,
  store,
  setup: signedIn(),
  render: () =>
    linkBlock([
      pr(41236, 'open', 'success', 'Share link API with expiring tokens'),
      pr(41240, 'open', 'success', 'Share dialog: copy-link button'),
      pr(41242, 'open', 'pending', 'Share link settings'),
      ...LINKS
    ]),
  interact: async (frame) => {
    rowButton(frame, '2 more').click()
    await wait(300)
    await hover(frame, 'Share dialog scaffolding')
  }
})

/** No repo on this host to read GitHub with: the row keeps its text tooltip. */
export const noGitHubRepo = defineFixture({
  width: 720,
  render: () => linkBlock(),
  interact: async (frame) => {
    hoverElement(rowButton(frame, 'Share dialog: view-only links'))
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
})

/** A file row keeps its tooltip. */
export const fileChipTooltip = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => linkBlock(),
  interact: async (frame) => {
    hoverElement(rowButton(frame, 'share-dialog-mock'))
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
})

/** The bot's folder has a same-id twin on a paired server, and the active selection names the twin:
 *  the card still reads GitHub through the bot's own host, so it shows the PR, not the fallback. */
export const activeTwinOnOtherHost = defineFixture({
  width: 720,
  store: {
    ...store,
    folderWorkspaces: [
      ...store.folderWorkspaces,
      makeFolderWorkspace({
        id: sampleBot.folderWorkspaceId,
        projectGroupId: 'bots',
        name: sampleBot.name,
        folderPath: '/home/fixture/.orca/bots/sample',
        executionHostId: 'runtime:studio'
      })
    ],
    activeWorktreeId: `folder:${sampleBot.folderWorkspaceId}`,
    activeWorkspaceExecutionHostId: 'runtime:studio'
  },
  setup: signedIn(),
  render: () => linkBlock([pr(41236, 'open', 'success', 'Share link API with expiring tokens')]),
  interact: (frame) => hover(frame, 'Share link API')
})

/** Keyboard focus opens the card; the first Escape closes only the card, the second goes Back. */
export const escapeClosesCardFirst = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => <PaneProbe />,
  interact: async (frame) => {
    const target = rowButton(frame, 'Share dialog: view-only links')
    target.focus()
    await wait(700)
    escape(target)
    await wait(300)
    escape(target)
    await wait(300)
  }
})

/** A click on a row whose card is open opens the link, as before, and the card goes away. */
export const clickOpensLink = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => <PaneProbe />,
  interact: async (frame) => {
    const target = rowButton(frame, 'Share dialog scaffolding')
    hoverElement(target)
    await wait(700)
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }))
    target.click()
    await wait(300)
  }
})

/** A 600px window at its largest zoom leaves about 250 CSS px: the card narrows to the window. */
export const zoomedNarrowWindow = defineFixture({
  width: 260,
  store,
  setup: signedIn(),
  render: () => linkBlock(),
  interact: (frame) => hover(frame, 'Share dialog: view-only links')
})

/** Nothing pre-hovered: for driving the rows with a real pointer and keyboard. */
export const idle = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => <PaneProbe />
})

/** The failing PR's first lookup fails and a retry answers: for driving Retry and a reopened card with
 *  a real pointer and keyboard, in the Links block. */
export const retryRecovers = defineFixture({
  width: 720,
  store,
  setup: signedIn('failOnce'),
  render: () => (
    <PaneProbe
      links={[...LINKS, pr(FAILING, 'open', 'pending', 'Share dialog keyboard shortcuts')]}
    />
  )
})

/** The PR changed after the row read its checks: the loaded card shows the new title and never the
 *  row's older reading as if current (the lookup itself carries no CI). */
export const staleChecksOmitted = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () =>
    linkBlock([
      pr(STALE_CHECKS, 'open', 'success', 'Share dialog: copy-link button', now - 3 * hour)
    ]),
  interact: (frame) => hover(frame, 'Share dialog: copy-link button')
})
