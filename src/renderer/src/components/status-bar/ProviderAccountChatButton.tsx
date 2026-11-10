import type { ComponentProps } from 'react'
import { ChevronDown, UserRound, UserRoundPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export type ChatAccountAction = { target: RuntimeClientTarget; canSwitch: () => Promise<boolean> }

export function ProviderAccountChatButton({
  provider,
  add = false,
  disabled,
  target,
  ...buttonProps
}: ComponentProps<typeof Button> & {
  provider: 'claude'
  target: RuntimeClientTarget
  add?: boolean
  disabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const label = add
    ? t('components.native-chat.usageLimitActions.addAccount', 'Add Account…')
    : t('components.native-chat.usageLimitActions.switchAccount', 'Switch Account')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...buttonProps}
          type="button"
          variant="outline"
          size={add ? 'icon-xs' : 'xs'}
          aria-label={label}
          disabled={disabled}
          onClick={
            add
              ? () => {
                  openSettingsTarget({
                    pane: 'accounts',
                    repoId: null,
                    sectionId: `accounts-${provider}`,
                    hostScope: target,
                    intent: 'native-accounts'
                  })
                  openSettingsPage()
                }
              : buttonProps.onClick
          }
        >
          {add ? (
            <UserRoundPlus />
          ) : (
            <>
              <UserRound />
              <ChevronDown />
            </>
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function providerChatAccountControl(
  provider: 'claude',
  action: ChatAccountAction | undefined,
  loaded: boolean,
  signedInCount: number,
  busy: boolean
): { add: boolean; button: React.JSX.Element } | undefined {
  if (!action) {
    return undefined
  }
  const add = loaded && signedInCount <= 1
  return {
    add,
    button: (
      <ProviderAccountChatButton
        provider={provider}
        add={add}
        target={action.target}
        disabled={!loaded || busy}
      />
    )
  }
}
