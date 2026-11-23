import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import type { BotItemLinkView } from '../../../../../shared/bots/bot-items'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { githubRepoIdentityKey } from '../../../../../shared/github/repositories/repository-identity-key'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { rememberRepoSlug, repoSlugCacheKey } from '@/lib/workspace/catalog/repo-slug-cache'
import { useState } from 'react'
import { NativeChatLinkClickContext } from '@/components/native-chat/links/actions/native-chat-link-click-context'
import { BotItemLinkChips } from './BotItemLinkChips'

const now = Date.now()
const hour = 3_600_000

// A clone of acme/app on this host: the GitHub sign-in its links' cards are read with.
const REPO: Repo = {
  id: 'repo-app',
  path: '/home/fixture/app',
  displayName: 'app',
  badgeColor: '#3b82f6',
  addedAt: 0
}

// Local avatars: a fixture never loads a real account's picture.
const avatar = (color: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="${color}"/></svg>`)}`

const ITEMS: Record<number, Omit<GitHubWorkItem, 'repoId'>> = {
  41230: {
    id: 'pr-41230',
    type: 'pr',
    number: 41230,
    title: 'Share dialog: view-only links by default',
    state: 'open',
    url: 'https://github.com/acme/app/pull/41230',
    labels: [],
    updatedAt: new Date(now - 2 * hour).toISOString(),
    author: 'sam-dev',
    authorAvatarUrl: avatar('#7c3aed'),
    additions: 214,
    deletions: 37
  },
  41236: {
    id: 'pr-41236',
    type: 'pr',
    number: 41236,
    title: 'Share link API with expiring tokens',
    state: 'open',
    url: 'https://github.com/acme/app/pull/41236',
    labels: [],
    updatedAt: new Date(now - 3 * hour).toISOString(),
    author: 'alex-dev',
    authorAvatarUrl: avatar('#0891b2'),
    additions: 158,
    deletions: 21
  },
  41188: {
    id: 'pr-41188',
    type: 'pr',
    number: 41188,
    title: 'Share dialog scaffolding',
    state: 'merged',
    url: 'https://github.com/acme/app/pull/41188',
    labels: [],
    updatedAt: new Date(now - 26 * hour).toISOString(),
    author: 'alex-dev',
    authorAvatarUrl: avatar('#0891b2'),
    additions: 96,
    deletions: 12
  },
  41201: {
    id: 'issue-41201',
    type: 'issue',
    number: 41201,
    title: 'Share links open as editable for viewers',
    state: 'open',
    url: 'https://github.com/acme/app/issues/41201',
    labels: ['bug', 'sharing'],
    updatedAt: new Date(now - 5 * hour).toISOString(),
    author: 'robin-qa',
    authorAvatarUrl: avatar('#d97706'),
    commentCount: 4
  }
}

const FAILING = 41299
const LOADING = 41298

const pr = (
  number: number,
  state: 'open' | 'merged',
  checks: string | null,
  title: string
): BotItemLinkView => ({
  kind: 'pr',
  ref: `acme/app#${number}`,
  pr: {
    shown: true,
    ref: `acme/app#${number}`,
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    state,
    checks,
    review: null,
    title,
    checkedAt: now
  }
})

const LINKS: BotItemLinkView[] = [
  pr(41230, 'open', 'failure', 'Share dialog: view-only links by default'),
  pr(41188, 'merged', 'success', 'Share dialog scaffolding'),
  {
    kind: 'url',
    ref: 'https://github.com/acme/app/issues/41201',
    issue: { title: 'Share links open as editable for viewers', state: 'open' }
  },
  { kind: 'file', ref: 'notes/share-dialog-mock.html' }
]

const store = {
  repos: [REPO],
  folderWorkspaces: [
    makeFolderWorkspace({
      id: fixtureCos.folderWorkspaceId,
      projectGroupId: 'bots',
      name: fixtureCos.name,
      folderPath: '/home/fixture/.orca/bots/cos'
    })
  ]
}

function signedIn(answer: 'item' | 'fail' = 'item'): () => void {
  return () => {
    const key = repoSlugCacheKey(REPO)
    if (key) {
      rememberRepoSlug(key, githubRepoIdentityKey({ owner: 'acme', repo: 'app' }))
    }
    window.api.gh.workItemByOwnerRepo = async ({ number }) => {
      if (answer === 'fail' && number === FAILING) {
        throw new Error('GitHub is unreachable')
      }
      if (number === LOADING) {
        return new Promise<never>(() => {})
      }
      return ITEMS[number] ?? null
    }
  }
}

// Room below for the card, which opens under the chip as tooltips do.
const header = (links: BotItemLinkView[] = LINKS) => (
  <div className="flex flex-col gap-1.5 px-3 pb-44 pt-6">
    <div className="text-sm font-semibold text-foreground">#1385 Share dialog follow-up</div>
    <BotItemLinkChips bot={fixtureCos} links={links} chat="Home Chat" />
  </div>
)

/** A narrow item pane at the window's right edge, beside the rest of the window. */
const narrowHeader = () => (
  <div className="flex">
    <div className="flex-1" />
    <div className="w-[360px] border-l border-border">{header()}</div>
  </div>
)

const chip = (frame: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...frame.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text)
  )
  if (!found) {
    throw new Error(`Missing chip ${text}`)
  }
  return found
}

const hover = async (frame: HTMLElement, text: string): Promise<void> => {
  hoverElement(chip(frame, text))
  await new Promise((resolve) => setTimeout(resolve, 700))
}

const hoverElement = (element: Element): void => {
  element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  // A tooltip opens on pointer movement.
  element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
}

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
  render: () => header(),
  interact: (frame) => hover(frame, '#41188')
})

export const hoverIssue = defineFixture({
  width: 720,
  store,
  setup: signedIn(),
  render: () => header(),
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
  render: () =>
    header([
      pr(41236, 'open', 'success', 'Share link API with expiring tokens'),
      pr(41230, 'open', 'failure', 'Share dialog: view-only links by default')
    ]),
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

/** "+N": a GitHub row in its popover shows the same card. */
export const overflowRow = defineFixture({
  width: 420,
  store,
  setup: signedIn(),
  render: () => header(),
  interact: async (frame) => {
    const more = [...frame.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
      button.textContent?.startsWith('+')
    )
    more?.click()
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
  render: () => header(),
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

/** The item pane's keys and link handler, reduced to what they report: Escape the pane would take as
 *  Back (only when nothing before it claimed the key), and the link a chip opened. */
function PaneProbe(): React.JSX.Element {
  const [log, setLog] = useState<string[]>([])
  const note = (line: string) => setLog((lines) => [...lines, line])
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          note(event.defaultPrevented ? 'Escape: taken by the card' : 'Escape: pane goes Back')
        }
      }}
    >
      <NativeChatLinkClickContext
        value={(event, url) => {
          event.preventDefault()
          note(`Opened ${url}`)
        }}
      >
        {header()}
      </NativeChatLinkClickContext>
      <div data-probe-log="" className="px-3 pb-3 font-mono text-xs text-muted-foreground">
        {log.length > 0 ? log.join(' | ') : 'No pane events'}
      </div>
    </div>
  )
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const escape = (target: Element) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  )

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
  render: () => <PaneProbe />,
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
