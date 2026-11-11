import { defineFixture } from '../../component-fixtures/component-fixture'
import { CloudWorkspaceNumberChip } from './CloudWorkspaceNumberChip'
import { refreshCloudWorktreeBindings, rememberCloudWorkspaces } from './cloud-workspace-identity'
import { workspace } from './cloud-workspaces.test-fixture'

const WORKTREE = 'repo-1::/vercel/orca/workspaces/app/fix-login'
const SANDBOX = 'sbx_00000000000000000000c197'

async function seed(): Promise<void> {
  Object.assign(window.api.cloudWorkspaces, {
    localWorkspaces: () =>
      Promise.resolve([{ sandboxId: SANDBOX, worktreeId: WORKTREE, runtimeEnvironmentId: null }]),
    environmentBindings: () => Promise.resolve({}),
    get: () => Promise.resolve({ ok: false as const, error: 'not_found' })
  })
  // The headless frame has no clipboard permission; the chip only needs the write to succeed.
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.resolve() }
  })
  rememberCloudWorkspaces([
    workspace({ id: SANDBOX, number: 197, link: 'orca://cloud/acme/W-197', title: 'Fix login' })
  ])
  await refreshCloudWorktreeBindings()
}

async function chip(frame: HTMLElement): Promise<HTMLButtonElement | null> {
  await seed()
  const deadline = performance.now() + 2000
  let button = frame.querySelector<HTMLButtonElement>('button')
  while (!button && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    button = frame.querySelector<HTMLButtonElement>('button')
  }
  return button
}

/** Shown beside Run in the workspace's tab bar: link glyph + W-number, muted at rest. */
export const atRest = defineFixture({
  width: 160,
  render: () => (
    <div className="flex items-center p-2">
      <CloudWorkspaceNumberChip worktreeId={WORKTREE} />
    </div>
  ),
  interact: async (frame) => {
    await chip(frame)
  }
})

/** Keyboard focus shows the ring and the "Copy link to W-197" tooltip. */
export const focused = defineFixture({
  width: 260,
  render: () => (
    <div className="flex h-20 items-start p-2">
      <CloudWorkspaceNumberChip worktreeId={WORKTREE} />
    </div>
  ),
  interact: async (frame) => {
    ;(await chip(frame))?.focus()
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
})

/** After a click: "Link copied" in place for about 1.5 s, no toast. */
export const copied = defineFixture({
  width: 160,
  render: () => (
    <div className="flex items-center p-2">
      <CloudWorkspaceNumberChip worktreeId={WORKTREE} />
    </div>
  ),
  interact: async (frame) => {
    ;(await chip(frame))?.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
})
