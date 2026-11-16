import { Settings, Users } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'
import { AccountMenuTrialRow } from './AccountMenuTrialRow'
import { sampleTrial, sampleTrialUsedUp } from './plan-billing-fixtures'

function Menu({ entitlement }: { entitlement: OrcaBillingEntitlement }): React.JSX.Element {
  return (
    <div className="h-[260px] p-2">
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>NP</DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-60">
          <DropdownMenuItem>
            <span className="flex size-7 items-center justify-center rounded-full bg-foreground/85 text-xs font-medium text-background">
              N
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium">Neil Parker</span>
              <span className="truncate text-xs text-muted-foreground">neil@acme.dev</span>
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <AccountMenuTrialRow result={{ status: 'ok', entitlement }} />
          <DropdownMenuItem>
            <Users className="size-3.5" />
            Team
          </DropdownMenuItem>
          <DropdownMenuItem>
            <Settings className="size-3.5" />
            Settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

/** Owner or admin: the row opens the plans page. */
export const trialOwner = defineFixture({
  width: 320,
  render: () => <Menu entitlement={sampleTrial} />
})

/** Member: the same line, nothing to pick. */
export const trialMember = defineFixture({
  width: 320,
  render: () => <Menu entitlement={{ ...sampleTrial, canManageBilling: false }} />
})

export const trialUsedUpOwner = defineFixture({
  width: 320,
  render: () => <Menu entitlement={sampleTrialUsedUp} />
})
