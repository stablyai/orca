import { ChevronDown, Cloud, KeyRound, LogIn, Settings2 } from 'lucide-react'
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
import { useTranslate } from '@/i18n/use-translate'
import { antigravityChatAuthMethodLabel } from '@/components/provider-accounts/AntigravityChatAuthMethodItems'
import type { AntigravityChatAuthConfig } from '../../../../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { useNativeChatAntigravityAuth } from './native-chat-antigravity-auth'
import { antigravityChatAuthMenuItems } from './antigravity-chat-auth-choices'
import { antigravityProgramLabel } from './antigravity-auth-words'

type Method = AntigravityChatAuthConfig['method']

const ICONS: Record<Method, typeof KeyRound> = {
  'oauth-personal': LogIn,
  'oauth-business': LogIn,
  'gemini-api-key': KeyRound,
  'agent-platform': Cloud
}

/** How this Antigravity chat signs in, always in view, with the other methods one click away. */
export function NativeChatAntigravityAuthChip({
  textClassName
}: {
  textClassName: string
}): React.JSX.Element | null {
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
  const Icon = ICONS[chatMethod]
  const newChatsDiffer = chatMethod !== method
  return (
    <DropdownMenu onOpenChange={(open) => open && auth.refresh()}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-antigravity-auth-chip=""
          className="h-5.5 min-w-0 max-w-56 shrink justify-start"
          aria-label={t(
            'components.native-chat.antigravityAuth.chipLabel',
            'Antigravity signs in with {{method}}. Change',
            { method: shown }
          )}
          title={t(
            'components.native-chat.antigravityAuth.chipTitle',
            'Antigravity signs in with {{method}}',
            { method: shown }
          )}
        >
          {auth.switching ? (
            <LoadingSpinner className="size-3" />
          ) : (
            <Icon className="size-3" aria-hidden />
          )}
          <span className={textClassName}>{shown}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
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
