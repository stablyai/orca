// PARITY-FOLLOW (design review): Team and Following in the sidebar, between the nav and Projects.
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { DIRECTORY, SELF_ID } from '../../cloud-workspaces/cloud-workspaces.test-fixture'
import {
  SidebarFollowingSection,
  SidebarTeamList,
  type SidebarFollowedWorkspace,
  type SidebarTeammate
} from './SidebarTeamSections'

const noop = (): void => {}

const TEAM: SidebarTeammate[] = [
  { userId: SELF_ID, activity: null },
  { userId: 'user_alan', activity: null },
  { userId: 'user_grace', activity: { state: 'typing', workspaceLabel: 'Checkout retries' } },
  { userId: 'user_linus', activity: { state: 'viewing', workspaceLabel: 'Refund webhooks' } },
  { userId: 'user_mae', activity: null }
]

const FOLLOWING: SidebarFollowedWorkspace[] = [
  {
    sandboxId: 'sbx_a',
    title: 'Checkout retries',
    numberLabel: 'W-582',
    creatorId: 'user_grace',
    status: 'running',
    hereNow: 2
  },
  {
    sandboxId: 'sbx_b',
    title: 'Refund webhooks',
    numberLabel: 'W-577',
    creatorId: 'user_linus',
    status: 'asleep',
    hereNow: 0
  },
  {
    sandboxId: 'sbx_c',
    title: 'Ledger migration with a long title that truncates',
    numberLabel: 'W-561',
    creatorId: 'user_mae',
    status: 'archived',
    hereNow: 0
  }
]

/** Stands in for the sidebar column: nav above, Projects below. */
function Column({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex w-[300px] flex-col bg-worktree-sidebar py-2">
      <div className="px-4 py-1.5 text-[13px] text-worktree-sidebar-foreground/60">Tasks</div>
      <div className="px-4 py-1.5 text-[13px] text-worktree-sidebar-foreground/60">Automations</div>
      {children}
      <div className="mt-2 px-4 text-xs font-semibold text-muted-foreground/80">Projects</div>
      <div className="px-4 py-1.5 text-[13px] text-worktree-sidebar-foreground/60">master</div>
    </div>
  )
}

/** Both sections open: teammates active first; followed workspaces with status and who's here. */
export const teamAndFollowing = defineFixture({
  width: 340,
  render: () => (
    <Column>
      <SidebarTeamList
        members={TEAM}
        directory={DIRECTORY}
        selfId={SELF_ID}
        onOpenProfile={noop}
        onShowWorkspaces={noop}
      />
      <SidebarFollowingSection
        workspaces={FOLLOWING}
        directory={DIRECTORY}
        selfId={SELF_ID}
        onOpen={noop}
        onUnfollow={noop}
      />
    </Column>
  )
})

/** Collapsed headers keep the count; nothing followed hides Following entirely. */
export const collapsedAndEmpty = defineFixture({
  width: 340,
  render: () => (
    <Column>
      <SidebarTeamList
        members={TEAM}
        directory={DIRECTORY}
        selfId={SELF_ID}
        defaultOpen={false}
        onOpenProfile={noop}
        onShowWorkspaces={noop}
      />
      <SidebarFollowingSection
        workspaces={[]}
        directory={DIRECTORY}
        selfId={SELF_ID}
        onOpen={noop}
        onUnfollow={noop}
      />
    </Column>
  )
})

/** Hovering a row shows its action: a teammate's workspaces, or Unfollow. */
export const rowHover = defineFixture({
  width: 340,
  render: () => (
    <Column>
      <SidebarTeamList
        members={TEAM}
        directory={DIRECTORY}
        selfId={SELF_ID}
        onOpenProfile={noop}
        onShowWorkspaces={noop}
      />
      <SidebarFollowingSection
        workspaces={FOLLOWING}
        directory={DIRECTORY}
        selfId={SELF_ID}
        onOpen={noop}
        onUnfollow={noop}
      />
    </Column>
  ),
  interact: async (frame) => {
    for (const row of frame.querySelectorAll<HTMLElement>('.group\\/team-row')) {
      if (row.textContent?.includes('Grace') || row.textContent?.includes('Refund')) {
        row.classList.add('bg-worktree-sidebar-foreground/8')
        for (const el of row.querySelectorAll<HTMLElement>('.group-hover\\/team-row\\:hidden')) {
          el.style.display = 'none'
        }
        for (const el of row.querySelectorAll<HTMLElement>(
          '.group-hover\\/team-row\\:opacity-100'
        )) {
          el.style.opacity = '1'
        }
      }
    }
  }
})

/** A big team: 6 rows, then "Show all 9". */
export const teamCapped = defineFixture({
  width: 340,
  render: () => (
    <Column>
      <SidebarTeamList
        members={[
          ...TEAM,
          ...['Rosa Parks', 'Ken Thompson', 'Barbara Liskov', 'Edsger Dijkstra', 'Hedy Lamarr'].map(
            (_name, i) => ({ userId: `user_extra_${i}`, activity: null })
          )
        ]}
        directory={
          new Map([
            ...DIRECTORY,
            ...[
              'Rosa Parks',
              'Ken Thompson',
              'Barbara Liskov',
              'Edsger Dijkstra',
              'Hedy Lamarr'
            ].map((name, i): [string, { name: string; email: string | null }] => [
              `user_extra_${i}`,
              { name, email: null }
            ])
          ])
        }
        selfId={SELF_ID}
        onOpenProfile={noop}
        onShowWorkspaces={noop}
      />
    </Column>
  )
})
