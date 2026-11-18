import { defineFixture } from '../../../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { WorkspaceCodexAccountOptions } from './WorkspaceCodexAccountOptions'

export const accounts = defineFixture({
  width: 480,
  render: () => (
    <div className="h-64 bg-background p-4 text-foreground">
      <DropdownMenu open>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Codex account</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>For new sessions in this workspace</DropdownMenuLabel>
          <WorkspaceCodexAccountOptions
            accounts={[
              {
                id: 'personal',
                email: 'dev@example.com',
                displayName: 'Personal',
                workspaceLabel: 'Personal (Plus)',
                createdAt: 1,
                updatedAt: 1,
                lastAuthenticatedAt: 1
              },
              {
                id: 'work',
                email: 'dev@example.com',
                displayName: 'Work',
                workspaceLabel: 'Acme',
                createdAt: 1,
                updatedAt: 1,
                lastAuthenticatedAt: 1
              }
            ]}
            selectedId="work"
            loading={false}
            saving={false}
            error={null}
            onSelect={() => {}}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})
