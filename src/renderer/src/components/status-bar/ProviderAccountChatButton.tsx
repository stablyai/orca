import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
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
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  return (
    <Button
      {...buttonProps}
      type="button"
      variant="outline"
      size="xs"
      className="w-full"
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
      {add
        ? translate('components.native-chat.usageLimitActions.addAccount', 'Add Account…')
        : translate('components.native-chat.usageLimitActions.switchAccount', 'Switch Account')}
    </Button>
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
