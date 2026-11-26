import { Settings2 } from 'lucide-react'
import googleLogo from '@/assets/connector-brands/google.svg'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { antigravityChatAuthMethodLabel } from '@/components/provider-accounts/AntigravityChatAuthMethodItems'
import { isAntigravityGoogleMethod } from '@/components/provider-accounts/antigravity-chat-runtime-sign-in-policy'
import { useNativeChatAntigravityAuth } from './native-chat-antigravity-auth'
import { antigravityChatAuthMenuItems } from './antigravity-chat-auth-choices'
import { antigravityProgramLabel } from './antigravity-auth-words'

/** How this Antigravity chat signs in, as Google's mark with the method on hover and in its menu. */
export function NativeChatAntigravityAuthChip(): React.JSX.Element | null {
  const t = useTranslate()
  const auth = useNativeChatAntigravityAuth()
  const method = auth?.detection?.method
  if (!auth || !method) {
    return null
  }
  const items = antigravityChatAuthMenuItems(auth.detection, auth.keyAndAdc)
  // A chat on agy's own home keeps its Google login; the saved method applies to new chats.
  const chatMethod = auth.ownLogin ? 'oauth-personal' : method
  const label = antigravityChatAuthMethodLabel(chatMethod, t) ?? ''
  const project = chatMethod === 'agent-platform' ? auth.detection?.adc.project : null
  const shown = project ? `${label} · ${project}` : label
  // The host's current version; a chat started before an upgrade runs the older one until it restarts.
  const program = auth.agy
    ? antigravityProgramLabel(
        auth.agy === 'orcas',
        auth.detection?.agyVersion ?? (auth.agy === 'orcas' ? auth.managedVersion : null),
        t
      )
    : null
  const signedOut = isAntigravityGoogleMethod(chatMethod) && auth.detection?.agySignedOut === true
  const status = signedOut
    ? t('components.native-chat.antigravityAuth.signedOutMethod', '{{method}}, signed out', {
        method: shown
      })
    : shown
  const newChatsDiffer = chatMethod !== method
  return (
    <DropdownMenu onOpenChange={(open) => open && auth.refresh()}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-xs"
              data-antigravity-auth-chip=""
              // Pulls the 16px mark flush with the footer padding, where the left icons start.
              className="relative -mr-[5px] w-[26px]"
              aria-label={t(
                'components.native-chat.antigravityAuth.chipLabel',
                'Antigravity signs in with {{method}}. Change',
                { method: status }
              )}
            >
              {auth.switching ? (
                <LoadingSpinner className="size-4" />
              ) : (
                <img src={googleLogo} alt="" aria-hidden className="size-4" />
              )}
              {signedOut ? (
                <span
                  aria-hidden
                  className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-destructive ring-[1.5px] ring-background"
                />
              ) : null}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4} className="max-w-80">
          <span className="block truncate">
            {t('components.native-chat.antigravityAuth.chipTooltip', 'Google · {{method}}', {
              method: status
            })}
          </span>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="top" className="w-72">
        <DropdownMenuLabel>
          {t('components.native-chat.antigravityAuth.menuTitle', 'Antigravity signs in with')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={method}>
          {items.map((item) => (
            <DropdownMenuRadioItem
              key={item.method}
              value={item.method}
              disabled={auth.switching !== null}
              onSelect={() => {
                if (item.active) {
                  return
                }
                if (item.opensSettings || item.method === 'oauth-business') {
                  auth.openSettings()
                } else {
                  auth.switchTo(item.method)
                }
              }}
            >
              <span className="min-w-0 flex-1 truncate">
                {antigravityChatAuthMethodLabel(item.method, t)}
                {item.opensSettings ? '…' : ''}
              </span>
              {item.detected ? (
                <span className="shrink-0 rounded-sm bg-primary/10 px-1.5 py-0.5 text-2xs font-medium text-primary">
                  {t('components.native-chat.antigravityAuth.detected', 'Detected')}
                </span>
              ) : null}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        {newChatsDiffer ? (
          <p className="px-2 py-1.5 text-2xs text-muted-foreground">
            {t(
              'components.native-chat.antigravityAuth.keepsOwnLogin',
              "This chat keeps agy's own Google login. New chats use {{method}}.",
              { method: antigravityChatAuthMethodLabel(method, t) ?? method }
            )}
          </p>
        ) : null}
        {program ? (
          <p data-antigravity-program="" className="px-2 py-1.5 text-2xs text-muted-foreground">
            {t('components.native-chat.antigravityAuth.runsOn', 'Runs on: {{program}}', {
              program
            })}
          </p>
        ) : null}
        <DropdownMenuItem onSelect={auth.openSettings}>
          <Settings2 className="size-3.5" aria-hidden />
          {t('components.native-chat.antigravityAuth.settings', 'Sign-in settings…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
