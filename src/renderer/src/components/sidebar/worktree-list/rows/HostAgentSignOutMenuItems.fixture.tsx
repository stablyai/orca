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
import { HostAgentSignOutMenuItems } from './HostAgentSignOutMenuItems'

export const signedIn = defineFixture({
  width: 320,
  setup: () =>
    rememberHostAgentSignInReport('env-m4air', {
      checkedAt: 0,
      agents: [
        { agent: 'claude', state: 'signedIn', method: 'orcaAccount' },
        { agent: 'codex', state: 'signedIn', method: 'cliLogin' }
      ]
    }),
  render: () => (
    <div className="h-[300px] p-2">
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>m4air</DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-56">
          <DropdownMenuLabel className="truncate text-[11px] font-medium text-muted-foreground">
            m4air
          </DropdownMenuLabel>
          <DropdownMenuItem>
            <Pencil className="size-3.5" />
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem>
            <RefreshCw className="size-3.5" />
            Check connection
          </DropdownMenuItem>
          <HostAgentSignOutMenuItems environmentId="env-m4air" hostLabel="m4air" open={false} />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})
