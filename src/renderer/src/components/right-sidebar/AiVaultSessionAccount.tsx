import type React from 'react'
import { UserRound } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { SessionReceiptSection } from './AiVaultSessionReceiptSection'

export function SessionAccountSection({
  accountLabel
}: {
  accountLabel: string | null
}): React.JSX.Element {
  return (
    <SessionReceiptSection
      icon={<UserRound className="size-3" />}
      label={translate('aiVault.sessionAccount', 'Account')}
    >
      <div
        className={cn(
          'select-text text-[12px] leading-4 [overflow-wrap:anywhere]',
          accountLabel ? 'font-medium text-foreground' : 'text-muted-foreground'
        )}
      >
        {accountLabel ?? translate('aiVault.sessionAccountUnknown', 'Unknown')}
      </div>
    </SessionReceiptSection>
  )
}
