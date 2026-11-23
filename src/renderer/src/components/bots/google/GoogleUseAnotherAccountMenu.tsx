import React from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'

function Choice({ title, detail }: { title: string; detail: string }): React.JSX.Element {
  return (
    <span className="flex flex-col items-start gap-0.5 py-0.5">
      <span className="text-xs font-medium text-foreground">{title}</span>
      <span className="text-[11px] text-muted-foreground">{detail}</span>
    </span>
  )
}

/** Use another account: sign in through the current Google app, or set up a new app first. */
export function GoogleUseAnotherAccountMenu({
  onSignIn,
  onNewApp,
  variant = 'outline',
  disabled
}: {
  onSignIn: () => void
  onNewApp: () => void
  variant?: 'outline' | 'ghost'
  disabled?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="sm" variant={variant} disabled={disabled}>
          {t('bots.google.useAnother', 'Use another account')}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuItem onSelect={onSignIn}>
          <Choice
            title={t('bots.google.useAnotherSignIn', 'Sign in with Google')}
            detail={t('bots.google.useAnotherSignInDetail', 'Uses your current Google app')}
          />
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onNewApp}>
          <Choice
            title={t('bots.google.setUpNewApp', 'Set up a new Google app')}
            detail={t(
              'bots.google.setUpNewAppDetail',
              'If your current app doesn’t work for this account or organization'
            )}
          />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
