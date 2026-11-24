import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import type { BotItemLinkView } from '../../../../../shared/bots/bot-items'
import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import { useRef } from 'react'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { NativeChatLinkClickContext } from '@/components/native-chat/links/actions/native-chat-link-click-context'
import { useNativeChatLinkActions } from '@/components/native-chat/links/actions/use-native-chat-link-actions'
import { BotItemLinks } from './BotItemLinks'

const now = Date.now()
const SHARE_DIALOG_ISSUE: LinearIssue = {
  id: 'lin-1',
  identifier: 'ENG-4120',
  title: 'Share dialog',
  url: 'https://linear.app/acme/issue/eng-4120',
  state: { name: 'Todo', type: 'unstarted', color: '#999999' },
  team: { id: 't1', name: 'Eng', key: 'ENG' },
  labels: [],
  labelIds: [],
  priority: 0,
  updatedAt: '2026-11-14T00:00:00Z'
}
const min = 60_000
type PrState = 'open' | 'draft' | 'merged' | 'closed'
const pr = (
  repo: string,
  number: number,
  state: PrState,
  checks: string | null,
  title: string
) => ({
  shown: true as const,
  ref: `${repo}#${number}`,
  number,
  url: `https://github.com/${repo}/pull/${number}`,
  state,
  checks,
  review: null,
  title,
  checkedAt: now
})
const prLink = (p: ReturnType<typeof pr>): BotItemLinkView => ({ kind: 'pr', ref: p.ref, pr: p })
const worker = (
  ref: string,
  title: string,
  state: 'working' | 'completed' | 'failed',
  extra: Partial<Extract<BotItemLinkView, { kind: 'dispatch' }>> = {}
): BotItemLinkView => ({
  kind: 'dispatch',
  ref,
  latest: null,
  title,
  state,
  host: null,
  startedAt: now - 60 * min,
  settledAt: state === 'working' ? null : now - 12 * min,
  report:
    state === 'working'
      ? null
      : { subject: 'Dialog built to the mock; opened #41230.', body: null },
  pr: null,
  ...extra
})

const frame = (links: BotItemLinkView[]) => (
  <div className="@container p-3">
    <BotItemLinks bot={fixtureCos} links={links} chat="Home Chat" />
  </div>
)

export const liveWorkersAndPr = defineFixture({
  width: 360,
  render: () =>
    frame([
      worker('d1', 'Fix the snapshot test', 'working', { startedAt: now - 6 * min }),
      worker('d2', 'Build the share dialog', 'completed'),
      worker('d3', 'Share link API', 'failed'),
      prLink(pr('acme/app', 41230, 'open', 'failure', 'Share dialog: view-only links by default')),
      prLink(pr('acme/app', 41188, 'merged', 'success', 'Share dialog scaffolding')),
      { kind: 'file', ref: 'share-dialog-mock.html' }
    ])
})

/** The signed-off mock's link set: every PR state, an uncached PR, a cached issue, another repo. */
export const mixedLinks = defineFixture({
  width: 400,
  store: {
    linearIssueCache: {
      'ENG-4120': {
        data: SHARE_DIALOG_ISSUE,
        fetchedAt: now
      }
    }
  },
  render: () =>
    frame([
      worker('d1', 'Fix the snapshot test', 'working', { startedAt: now - 6 * min }),
      worker('d2', 'Build the share dialog', 'completed'),
      {
        kind: 'url',
        ref: 'https://github.com/acme/app/issues/41201',
        issue: { title: 'Share links open as editable for viewers', state: 'open' }
      },
      prLink(pr('acme/app', 41230, 'open', 'failure', 'Share dialog: view-only links by default')),
      prLink(pr('acme/app', 41236, 'open', 'success', 'Share link API with expiring tokens')),
      prLink(pr('acme/app', 41188, 'merged', 'success', 'Share dialog scaffolding')),
      prLink(pr('acme/infra', 412, 'closed', 'failure', 'Raise the share link rate limit')),
      prLink(pr('acme/app', 41251, 'draft', 'pending', 'Share dialog copy pass')),
      { kind: 'pr', ref: 'acme/app#41240', pr: null },
      { kind: 'url', ref: 'https://github.com/acme/app/issues/41199' },
      { kind: 'url', ref: 'https://linear.app/globex/issue/ENG-4120/share-dialog' },
      { kind: 'url', ref: 'https://example.com/docs/sharing' },
      {
        kind: 'url',
        ref: 'https://docs.example.com/guides/collaboration/sharing/permissions/view-only-links-explained'
      },
      { kind: 'url', ref: 'https://globex.slack.com/archives/C0123/p1731500000' },
      { kind: 'file', ref: 'notes/share-dialog-mock.html' },
      worker('d4', 'Repro dictation drop', 'working', {
        host: 'runtime:studio',
        pr: { shown: false, reason: 'server' }
      })
    ])
})

/** A worker's PR the host read open with passing checks, merged since: this window's later read
 *  wins, so the row shows merged, not the old CI result. */
export const mergedSinceHostRead = defineFixture({
  width: 400,
  store: {
    prCache: {
      'acme/app::share-dialog': {
        data: {
          number: 41188,
          title: 'Share dialog scaffolding',
          state: 'merged',
          url: 'https://github.com/acme/app/pull/41188',
          checksStatus: 'success',
          updatedAt: '2026-11-16T00:00:00Z',
          mergeable: 'UNKNOWN'
        },
        fetchedAt: now
      }
    }
  },
  render: () =>
    frame([
      prLink({
        ...pr('acme/app', 41188, 'open', 'success', 'Share dialog scaffolding'),
        checkedAt: now - 240 * min
      }),
      prLink(pr('acme/app', 41230, 'open', 'success', 'Share dialog: view-only links by default'))
    ])
})

export const serverWork = defineFixture({
  width: 360,
  render: () =>
    frame([
      worker('d4', 'Repro dictation drop', 'working', {
        host: 'runtime:studio',
        pr: { shown: false, reason: 'server' }
      })
    ])
})

/** The failing PR's tooltip: state, checks, repo. */
export const prTooltip = defineFixture({
  width: 400,
  render: () =>
    frame([
      worker('d1', 'Fix the snapshot test', 'working', { startedAt: now - 6 * min }),
      prLink(pr('acme/app', 41230, 'open', 'failure', 'Share dialog: view-only links by default')),
      prLink(pr('acme/app', 41188, 'merged', 'success', 'Share dialog scaffolding'))
    ]),
  interact: async (frame) => {
    const rows = [...frame.querySelectorAll<HTMLButtonElement>('button')]
    rows.find((row) => row.textContent?.includes('#41230'))?.focus()
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})

const FOLDER_CONTEXT = {
  worktreeId: 'folder:fixture',
  worktreePath: '/bots/cos',
  runtimeEnvironmentId: null
}

/** The item view's link wiring: its link handler and the shared link popover. */
function WithItemViewLinks({ links }: { links: BotItemLinkView[] }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const actions = useNativeChatLinkActions(FOLDER_CONTEXT, root, {
    sessionId: null,
    isVisible: true,
    followsLinkMode: false
  })
  return (
    <div ref={root}>
      <NativeChatLinkClickContext value={actions.onLinkClick}>
        {frame(links)}
      </NativeChatLinkClickContext>
      <LinkActionPopover request={actions.linkActionRequest} onClose={actions.closeLinkActions} />
    </div>
  )
}

const clickRow = (frame: HTMLElement, text: string): void => {
  const row = [...frame.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes(text)
  )
  row?.dispatchEvent(
    new MouseEvent('click', { bubbles: true, button: 0, clientX: 40, clientY: 120 })
  )
}

/** A PR row's click: the workspace card's link popover (URL, copy, settings, browsers). */
export const prPopover = defineFixture({
  width: 400,
  store: {
    folderWorkspaces: [makeFolderWorkspace({ id: 'fixture', name: 'Cos', folderPath: '/bots/cos' })]
  },
  render: () => (
    <div className="pt-28">
      <WithItemViewLinks
        links={[
          prLink(
            pr('acme/app', 41230, 'open', 'failure', 'Share dialog: view-only links by default')
          ),
          prLink(pr('acme/app', 41188, 'merged', 'success', 'Share dialog scaffolding'))
        ]}
      />
    </div>
  ),
  interact: async (frame) => {
    clickRow(frame, '#41230')
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})

/** A narrow panel: long titles ellipsize; hovering a row scrolls only the one that overflows. */
export const longTitles = defineFixture({
  width: 260,
  render: () =>
    frame([
      prLink(
        pr(
          'acme/app',
          41230,
          'open',
          'failure',
          'Share dialog: view-only links by default for every viewer'
        )
      ),
      prLink(pr('acme/app', 41188, 'merged', 'success', 'Scaffolding')),
      { kind: 'file', ref: 'notes/share-dialog-mock-with-a-very-long-file-name.html' }
    ])
})
