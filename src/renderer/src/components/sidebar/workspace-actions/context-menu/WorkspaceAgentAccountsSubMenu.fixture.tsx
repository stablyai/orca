import { defineFixture } from '../../../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { WorkspaceAgentAccountsSubMenu } from './WorkspaceAgentAccountsSubMenu'
import { WorkspaceAccountOptions } from './WorkspaceAccountOptions'

export const accounts = defineFixture({
  width: 600,
  render: () => (
    <div className="h-[560px] bg-background p-4 text-foreground">
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Workspace</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <WorkspaceAgentAccountsSubMenu disabled={false}>
            <DropdownMenuLabel>Codex</DropdownMenuLabel>
            <WorkspaceAccountOptions
              provider="Codex"
              accounts={[
                { id: 'personal', label: 'Personal (dev@example.com)' },
                { id: 'work', label: 'Work (team@example.com)' }
              ]}
              selectedId="work"
              loading={false}
              saving={false}
              error={null}
              onSelect={() => {}}
            />
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Claude</DropdownMenuLabel>
            <WorkspaceAccountOptions
              provider="Claude"
              accounts={[{ id: 'claude-work', label: 'Work (claude@example.com)' }]}
              loading={false}
              saving={false}
              error={null}
              onSelect={() => {}}
            />
          </WorkspaceAgentAccountsSubMenu>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ),
  interact: async () => {
    const trigger = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-trigger"]')
    trigger?.focus()
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await new Promise(requestAnimationFrame)
  }
})
