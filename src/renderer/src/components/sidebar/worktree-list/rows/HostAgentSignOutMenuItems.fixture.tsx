import { Pencil, RefreshCw } from 'lucide-react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { rememberHostAgentSignInReport } from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import { HostAgentSignOutDialog, HostAgentSignOutMenuItems } from './HostAgentSignOutMenuItems'

export const signedIn = defineFixture({
  width: 320,
  setup: () =>
    rememberHostAgentSignInReport('env-dev-mac', {
      checkedAt: 0,
      agents: [
        { agent: 'claude', state: 'signedIn', method: 'orcaAccount' },
        { agent: 'codex', state: 'signedIn', method: 'cliLogin' }
      ]
    }),
  render: () => (
    <div className="h-[300px] p-2">
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>dev-mac</DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-56">
          <DropdownMenuLabel className="truncate text-[11px] font-medium text-muted-foreground">
            dev-mac
          </DropdownMenuLabel>
          <DropdownMenuItem>
            <Pencil className="size-3.5" />
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem>
            <RefreshCw className="size-3.5" />
            Check connection
          </DropdownMenuItem>
          <HostAgentSignOutMenuItems
            environmentId="env-dev-mac"
            hostLabel="dev-mac"
            open={false}
            onSignOut={() => {}}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})

export const confirm = defineFixture({
  width: 520,
  render: () => (
    <div className="h-[260px]">
      <HostAgentSignOutDialog
        environmentId="env-dev-mac"
        hostLabel="dev-mac"
        agent="claude"
        onClose={() => {}}
      />
    </div>
  )
})
