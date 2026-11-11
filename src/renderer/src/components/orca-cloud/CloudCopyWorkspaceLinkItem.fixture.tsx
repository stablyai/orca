import { Copy } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { CloudCopyWorkspaceLinkItem } from './CloudWorkspaceMenuItems'
import { workspace } from '../cloud-workspaces/cloud-workspaces.test-fixture'

const WORKTREE = 'repo-1::/vercel/orca/workspaces/app/fix-login'
const SANDBOX = 'sbx_00000000000000000000c197'

/** The sidebar's right-click Copy ▸ submenu for a cloud workspace: "Link to W-197", Path, Worktree Name. */
export const sidebarCopySubmenu = defineFixture({
  width: 520,
  setup: () => {
    Object.assign(window.api.cloudWorkspaces, {
      localWorkspaces: () =>
        Promise.resolve([{ sandboxId: SANDBOX, worktreeId: WORKTREE, runtimeEnvironmentId: null }]),
      environmentBindings: () => Promise.resolve({}),
      get: () =>
        Promise.resolve({
          ok: true as const,
          value: workspace({ id: SANDBOX, number: 197, title: 'Fix login' })
        })
    })
  },
  render: () => (
    <div className="h-[200px]">
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger className="sr-only">Menu</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Copy className="size-3.5" />
              Copy
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <CloudCopyWorkspaceLinkItem worktreeId={WORKTREE} />
              <DropdownMenuItem>
                <Copy className="size-3.5" />
                Path
              </DropdownMenuItem>
              <DropdownMenuItem>
                <Copy className="size-3.5" />
                Worktree Name
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
  interact: async () => {
    const deadline = performance.now() + 3000
    let trigger: HTMLElement | null = null
    while (!trigger && performance.now() < deadline) {
      trigger = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    trigger?.focus()
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    while (
      ![...document.querySelectorAll('[role=menuitem]')].some((el) =>
        el.textContent?.includes('W-197')
      ) &&
      performance.now() < deadline + 2000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
})
