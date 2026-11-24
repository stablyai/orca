// Shared seeded data and probes for the BotItemLinkChips fixtures: invented repos, people and PRs only.
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import type { BotItemLinkView } from '../../../../../shared/bots/bot-items'
import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { githubRepoIdentityKey } from '../../../../../shared/github/repositories/repository-identity-key'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { rememberRepoSlug, repoSlugCacheKey } from '@/lib/workspace/catalog/repo-slug-cache'
import { useRef, useState } from 'react'
import { NativeChatLinkClickContext } from '@/components/native-chat/links/actions/native-chat-link-click-context'
import { BotItemLinkChips } from './BotItemLinkChips'
import { typeIntoBotItemComment } from './bot-item-comment-typing'

export const now = Date.now()
export const hour = 3_600_000

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

export const FAILING = 41299
export const LOADING = 41298
// Pushed to since the chip last read its checks.
export const STALE_CHECKS = 41240

const author = {
  sam: { author: 'sam-dev', authorAvatarUrl: avatar('#7c3aed') },
  alex: { author: 'alex-dev', authorAvatarUrl: avatar('#0891b2') }
}

const prItem = (
  number: number,
  title: string,
  state: 'open' | 'merged',
  hoursAgo: number,
  by: (typeof author)[keyof typeof author],
  [additions, deletions]: [number, number]
): Omit<GitHubWorkItem, 'repoId'> => ({
  id: `pr-${number}`,
  type: 'pr',
  number,
  title,
  state,
  url: `https://github.com/acme/app/pull/${number}`,
  labels: [],
  updatedAt: new Date(now - hoursAgo * hour).toISOString(),
  ...by,
  additions,
  deletions
})

const ITEMS: Record<number, Omit<GitHubWorkItem, 'repoId'>> = {
  41230: prItem(
    41230,
    'Share dialog: view-only links by default',
    'open',
    2,
    author.sam,
    [214, 37]
  ),
  41236: prItem(41236, 'Share link API with expiring tokens', 'open', 3, author.alex, [158, 21]),
  41188: prItem(41188, 'Share dialog scaffolding', 'merged', 26, author.alex, [96, 12]),
  [FAILING]: prItem(FAILING, 'Share dialog keyboard shortcuts', 'open', 4, author.sam, [61, 4]),
  [STALE_CHECKS]: prItem(
    STALE_CHECKS,
    'Share dialog: copy-link button (reworked)',
    'open',
    1,
    author.alex,
    [40, 9]
  ),
  41201: {
    id: 'issue-41201',
    type: 'issue',
    number: 41201,
    title: 'Share links open as editable for viewers',
    state: 'open',
    url: 'https://github.com/acme/app/issues/41201',
    labels: ['bug', 'sharing', 'needs-design-review-before-the-next-release-train-cutoff-window'],
    updatedAt: new Date(now - 5 * hour).toISOString(),
    author: 'robin-qa',
    authorAvatarUrl: avatar('#d97706'),
    commentCount: 4
  }
}

export const pr = (
  number: number,
  state: 'open' | 'merged',
  checks: string | null,
  title: string,
  checkedAt = now
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
    checkedAt
  }
})

export const LINKS: BotItemLinkView[] = [
  pr(41230, 'open', 'failure', 'Share dialog: view-only links by default'),
  pr(41188, 'merged', 'success', 'Share dialog scaffolding'),
  {
    kind: 'url',
    ref: 'https://github.com/acme/app/issues/41201',
    issue: { title: 'Share links open as editable for viewers', state: 'open' }
  },
  { kind: 'file', ref: 'notes/share-dialog-mock.html' }
]

export const store = {
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

/** `failOnce`: the first lookup of the failing PR throws and later ones answer, as a retry would find.
 *  `window.fixtureLookups` counts the failing PR's lookups; with its `hold` set, the next one waits
 *  for `release(answers)`, so a probe can act while a retry is in flight. */
export function signedIn(answer: 'item' | 'fail' | 'failOnce' = 'item'): () => void {
  return () => {
    const lookups: {
      count: number
      hold: boolean
      release: ((answers: boolean) => void) | null
    } = { count: 0, hold: false, release: null }
    Object.assign(window, { fixtureLookups: lookups })
    const key = repoSlugCacheKey(REPO)
    if (key) {
      rememberRepoSlug(key, githubRepoIdentityKey({ owner: 'acme', repo: 'app' }))
    }
    window.api.gh.workItemByOwnerRepo = async ({ number }) => {
      if (number === FAILING) {
        lookups.count += 1
        const answers = lookups.hold
          ? await new Promise<boolean>((resolve) => {
              lookups.hold = false
              lookups.release = resolve
            })
          : !(answer === 'fail' || (answer === 'failOnce' && lookups.count === 1))
        if (!answers) {
          throw new Error('GitHub is unreachable')
        }
      }
      if (number === LOADING) {
        return new Promise<never>(() => {})
      }
      return ITEMS[number] ?? null
    }
  }
}

// Room below for the card, which opens under the chip as tooltips do.
export const header = (links: BotItemLinkView[] = LINKS) => (
  <div className="flex flex-col gap-1.5 px-3 pb-44 pt-6">
    <div className="text-sm font-semibold text-foreground">#1385 Share dialog follow-up</div>
    <BotItemLinkChips bot={fixtureCos} links={links} chat="Home Chat" />
  </div>
)

/** A narrow item pane at the window's right edge, beside the rest of the window. */
export const narrowHeader = () => (
  <div className="flex">
    <div className="flex-1" />
    <div className="w-[360px] border-l border-border">{header()}</div>
  </div>
)

export const chip = (frame: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...frame.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text)
  )
  if (!found) {
    throw new Error(`Missing chip ${text}`)
  }
  return found
}

export const hover = async (frame: HTMLElement, text: string): Promise<void> => {
  hoverElement(chip(frame, text))
  await new Promise((resolve) => setTimeout(resolve, 700))
}

export const hoverElement = (element: Element): void => {
  element.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  // A tooltip opens on pointer movement.
  element.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
}

/** The item pane's keys and link handler, reduced to what they report: Escape the pane would take as
 *  Back (only when nothing before it claimed the key), the link a chip opened, and the pane's own
 *  type-to-comment handler sending stray keys into a draft, as the real pane does. */
export function PaneProbe({ links }: { links?: BotItemLinkView[] }): React.JSX.Element {
  const [log, setLog] = useState<string[]>([])
  const [draft, setDraft] = useState('')
  const pane = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLTextAreaElement>(null)
  const note = (line: string) => setLog((lines) => [...lines, line])
  const comment = {
    type: (text: string) => {
      editor.current?.focus()
      setDraft((value) => value + text)
    }
  }
  return (
    <div
      ref={pane}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          note(event.defaultPrevented ? 'Escape: taken by the card' : 'Escape: pane goes Back')
          return
        }
        typeIntoBotItemComment(event, pane.current, comment)
      }}
    >
      <NativeChatLinkClickContext
        value={(event, url) => {
          event.preventDefault()
          note(`Opened ${url}`)
        }}
      >
        {header(links)}
      </NativeChatLinkClickContext>
      <div data-probe-log="" className="px-3 pb-3 font-mono text-xs text-muted-foreground">
        {log.length > 0 ? log.join(' | ') : 'No pane events'}
      </div>
      <textarea
        ref={editor}
        data-probe-draft=""
        aria-label="Comment draft"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        className="mx-3 h-8 w-64 rounded border border-border bg-background px-1 text-xs"
      />
    </div>
  )
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const escape = (target: Element) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  )
