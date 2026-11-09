import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudWorkspaceRow } from './CloudWorkspaceRow'
import type { RowActions } from './CloudWorkspaceRowMenu'
import {
  DIRECTORY,
  FIXTURE_NOW,
  presence,
  SELF_ID,
  teamWorkspaces,
  workspace
} from './cloud-workspaces.test-fixture'

const WIDTH = 760
const ACTIONS: RowActions = {
  open: () => {},
  copyLink: () => {},
  copyWorkspaceLink: () => {},
  goToChat: () => {},
  patch: () => {}
}
const SECTIONS = ['Payments', 'Platform']
const MEMBERS = [...DIRECTORY.entries()].map(([userId, m]) => ({ userId, name: m.name }))

// Shared with the team, a section, and two teammates in it: every menu entry is present.
const MENU_ROW = workspace({
  title: 'Checkout retries',
  section: 'Payments',
  presence: [presence('user_grace', 'typing'), presence('user_linus')]
})

function Row({
  w = MENU_ROW,
  opening = false
}: {
  w?: typeof MENU_ROW
  opening?: boolean
}): React.JSX.Element {
  return (
    <ul role="list" className="rounded-xl border border-border bg-card p-1">
      <CloudWorkspaceRow
        workspace={w}
        directory={DIRECTORY}
        selfId={SELF_ID}
        canAdmin
        sections={SECTIONS}
        members={MEMBERS}
        opening={opening}
        highlighted={false}
        now={FIXTURE_NOW}
        actions={ACTIONS}
      />
    </ul>
  )
}

async function waitFor<T>(find: () => T | null): Promise<T | null> {
  const deadline = performance.now() + 3000
  for (;;) {
    const found = find()
    if (found || performance.now() > deadline) {
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function openMenu(frame: HTMLElement): HTMLElement | null {
  const trigger = frame.querySelector<HTMLElement>('[data-slot="dropdown-menu-trigger"]')
  trigger?.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
  )
  return trigger
}

/** Opens a submenu by keyboard, the way Radix opens it for a focused sub-trigger. */
async function openSubmenu(frame: HTMLElement, label: string): Promise<void> {
  openMenu(frame)
  const subTrigger = await waitFor(
    () =>
      [...document.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')].find(
        (el) => el.textContent?.includes(label)
      ) ?? null
  )
  subTrigger?.focus()
  subTrigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  await waitFor(() => document.querySelector('[data-slot="dropdown-menu-sub-content"]'))
}

/** Each lifecycle state as its own row: status dot, status text, lock, cost and time. */
export const statuses = defineFixture({
  width: WIDTH,
  render: () => (
    <div className="flex flex-col gap-2">
      {teamWorkspaces().map((w) => (
        <Row key={w.id} w={w} />
      ))}
      <Row w={workspace({ title: 'Opening state' })} opening />
    </div>
  )
})

/** Share/private, copy links, go to a teammate's chat, move to section and reassign live in the row menu. */
export const menuOpen = defineFixture({
  width: WIDTH,
  render: () => (
    <div className="h-[420px]">
      <Row />
    </div>
  ),
  interact: async (frame) => {
    openMenu(frame)
    await waitFor(() => document.querySelector('[data-slot="dropdown-menu-content"]'))
  }
})

export const moveToSection = defineFixture({
  width: WIDTH,
  render: () => (
    <div className="h-[420px]">
      <Row />
    </div>
  ),
  interact: (frame) => openSubmenu(frame, 'Move to section')
})

export const reassignOwner = defineFixture({
  width: WIDTH,
  render: () => (
    <div className="h-[460px]">
      <Row />
    </div>
  ),
  interact: (frame) => openSubmenu(frame, 'Reassign owner')
})

export const followSubmenu = defineFixture({
  width: WIDTH,
  render: () => (
    <div className="h-[420px]">
      <Row />
    </div>
  ),
  interact: (frame) => openSubmenu(frame, "Go to a teammate's chat")
})

/** A private workspace offers "Share with team" instead of "Make private". */
export const privateMenu = defineFixture({
  width: WIDTH,
  render: () => (
    <div className="h-[420px]">
      <Row w={workspace({ title: 'Flaky e2e repro', visibility: 'private' })} />
    </div>
  ),
  interact: async (frame) => {
    openMenu(frame)
    await waitFor(() => document.querySelector('[data-slot="dropdown-menu-content"]'))
  }
})
