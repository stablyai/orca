import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import type { BotItemLinkView } from '../../../../../shared/bots/bot-items'
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
  header,
  narrowHeader,
  chip,
  hover,
  hoverElement,
  signedIn,
  PaneProbe,
  wait,
  escape
} from './bot-item-link-chips-fixtures'

/** Hovering an open PR chip whose checks fail: the GitHub card, not the text tooltip. */
export const hoverOpenPr = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => header(),
  interact: (frame) => hover(frame, '#41230')
})

export const hoverMergedPr = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => header(LINKS.slice(1, 2)),
  interact: (frame) => hover(frame, '#41188')
})

export const hoverIssue = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => header(LINKS.slice(2, 3)),
  interact: (frame) => hover(frame, '#41201')
})

/** Tab onto a chip: the same card opens. */
export const keyboardFocus = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => header(),
  interact: async (frame) => {
    chip(frame, '#41230').focus()
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
})

/** A narrow item pane: the chip still truncates and the card stays inside the window. */
export const narrowPane = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => narrowHeader(),
  interact: (frame) => hover(frame, '#41230')
})

/** An open PR with passing checks. */
export const hoverPassingPr = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => header([pr(41236, 'open', 'success', 'Share link API with expiring tokens')]),
  interact: (frame) => hover(frame, '#41236')
})

/** While the lookup runs: what the chip knows, not a skeleton. */
export const lookupLoading = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => header([pr(LOADING, 'open', 'pending', 'Share dialog analytics events')]),
  interact: (frame) => hover(frame, `#${LOADING}`)
})

/** The lookup fails: the card says what the chip knows (title, state, checks, repo). */
export const lookupFails = defineFixture({
  width: 720,
  store,
  setup: signedIn('fail'),
  render: () => header([pr(FAILING, 'open', 'pending', 'Share dialog keyboard shortcuts')]),
  interact: (frame) => hover(frame, `#${FAILING}`)
})

/** A GitHub row in the links menu shows the same card. */
export const overflowRow = defineFixture({
  width: 420,
  store,
  setup: signedIn(),
  render: () => header(LINKS),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="4 links"]')?.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const row = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-radix-popper-content-wrapper] button')
    ].find((button) => button.textContent?.includes('#41188'))
    if (!row) {
      throw new Error('Missing overflow row')
    }
    hoverElement(row)
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
})

/** No repo on this host to read GitHub with: the chip keeps its text tooltip. */
export const noGitHubRepo = defineFixture({
  width: 720,
  render: () => header(),
  interact: async (frame) => {
    hoverElement(chip(frame, '#41230'))
    await new Promise((resolve) => setTimeout(resolve, 900))
  }
})

/** A file chip keeps its tooltip. */
export const fileChipTooltip = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => header(LINKS.slice(3, 4)),
  interact: async (frame) => {
    hoverElement(chip(frame, 'share-dialog-mock'))
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
        id: fixtureCos.folderWorkspaceId,
        projectGroupId: 'bots',
        name: fixtureCos.name,
        folderPath: '/home/fixture/.orca/bots/cos',
        executionHostId: 'runtime:studio'
      })
    ],
    activeWorktreeId: `folder:${fixtureCos.folderWorkspaceId}`,
    activeWorkspaceExecutionHostId: 'runtime:studio'
  },
  setup: signedIn(),
  render: () => header([pr(41236, 'open', 'success', 'Share link API with expiring tokens')]),
  interact: (frame) => hover(frame, '#41236')
})

/** Keyboard focus opens the card; the first Escape closes only the card, the second goes Back. */
export const escapeClosesCardFirst = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => <PaneProbe />,
  interact: async (frame) => {
    const target = chip(frame, '#41230')
    target.focus()
    await wait(700)
    escape(target)
    await wait(300)
    escape(target)
    await wait(300)
  }
})

/** A click on a chip whose card is open opens the link, as before, and the card goes away. */
export const clickOpensLink = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => <PaneProbe links={LINKS.slice(1, 2)} />,
  interact: async (frame) => {
    const target = chip(frame, '#41188')
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
  render: () => header(),
  interact: (frame) => hover(frame, '#41230')
})

/** Nothing pre-hovered: for driving the chips with a real pointer and keyboard. */
export const idle = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => <PaneProbe />
})

/** The first lookup fails and a retry answers from the links menu. */
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

/** The PR changed after the chip read its checks: the loaded card shows the new title and never the
 *  chip's older reading as if current (the lookup itself carries no CI). */
export const staleChecksOmitted = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () =>
    header([pr(STALE_CHECKS, 'open', 'success', 'Share dialog: copy-link button', now - 3 * hour)]),
  interact: (frame) => hover(frame, `#${STALE_CHECKS}`)
})

const MANY: BotItemLinkView[] = Array.from({ length: 1000 }, (_, i): BotItemLinkView => {
  switch (i % 4) {
    case 0:
      return {
        kind: 'dispatch',
        ref: `ctx_${i}`,
        latest: null,
        title: `Worker ${i}`,
        state: 'completed',
        host: null,
        startedAt: now - hour,
        settledAt: now - hour / 2,
        report: { subject: 'Done.', body: null },
        pr: null
      }
    case 1:
      return { kind: 'url', ref: `https://example.com/runs/${i}` }
    case 2:
      return { kind: 'file', ref: `notes/run-${i}.md` }
    default:
      return pr(40000 + i, 'merged', 'success', `Change ${i}`)
  }
})

/** A busy item's 1,000 links: the menu draws the first page, scrolled to its Show more. */
export const thousandLinks = defineFixture({
  width: 720,
  store,
  render: () => header(MANY),
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="1000 links"]')?.click()
    await wait(100)
    const list = document.querySelector('[data-radix-popper-content-wrapper] .overflow-y-auto')
    list?.scrollTo({ top: list.scrollHeight })
    await wait(100)
  }
})
