import { useState } from 'react'
import type { ComponentProps } from 'react'
import { ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

export type ChatAccountAction = { target: RuntimeClientTarget; canSwitch: () => Promise<boolean> }

/** A chat's account icon button: a menu trigger (slotted props/ref) or, with `add`, Settings. */
export function ProviderAccountChatButton({
  provider,
  add = false,
  disabled,
  busy = false,
  target,
  onClick,
  onPointerDown,
  onKeyDown,
  ...buttonProps
}: ComponentProps<typeof Button> & {
  provider: 'claude' | 'antigravity'
  target: RuntimeClientTarget
  add?: boolean
  disabled: boolean
  /** Still learning whether the chat can switch; announced as busy. */
  busy?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const label = add
    ? t('components.native-chat.usageLimitActions.addAccount', 'Add account…')
    : t('components.native-chat.usageLimitActions.switchAccount', 'Switch account')
  // Why aria-disabled: a natively disabled button drops focus and can't show its tooltip; drop
  // the menu's slotted handlers instead so it can't open or act.
  const activation = disabled
    ? {}
    : {
        onPointerDown,
        onKeyDown,
        onClick: add
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
          : onClick
      }
  // The slotted menu marks itself open; its label would sit over the open menu.
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const menuOpen = buttonProps['aria-expanded'] === true || buttonProps['aria-expanded'] === 'true'
  return (
    <Tooltip open={tooltipOpen && !menuOpen} onOpenChange={setTooltipOpen}>
      <TooltipTrigger asChild>
        <Button
          {...buttonProps}
          {...activation}
          type="button"
          variant="chat-tool"
          size="icon-xs"
          aria-label={label}
          aria-disabled={disabled || undefined}
          aria-busy={busy || undefined}
        >
          <ArrowLeftRight className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

export function providerChatAccountControl(
  provider: 'claude' | 'antigravity',
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
