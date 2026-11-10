import type React from 'react'
import { UserRound } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { SessionReceiptSection } from '../session-list/AiVaultSessionReceiptSection'

export function SessionAccountSection({
  accountLabel
}: {
  accountLabel: string | null
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SessionReceiptSection
      icon={<UserRound className="size-3" />}
      label={t('aiVault.sessionAccount', 'Account')}
    >
      <div
        className={cn(
          'select-text text-[12px] leading-4 [overflow-wrap:anywhere]',
          accountLabel ? 'font-medium text-foreground' : 'text-muted-foreground'
        )}
      >
        {accountLabel ?? t('aiVault.sessionAccountUnknown', 'Unknown')}
      </div>
    </SessionReceiptSection>
  )
}
