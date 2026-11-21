import { ChevronDown, Cloud, KeyRound, LogIn, Settings2, SquareTerminal } from 'lucide-react'
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

const AGY = 'agy'

/** How this Antigravity chat signs in, always in view, with the other methods one click away. */
export function NativeChatAntigravityAuthChip({
  textClassName
}: {
  textClassName: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const auth = useNativeChatAntigravityAuth()
  const method = auth?.detection?.method
  const onAgy = auth?.backend === 'agy'
  if (!auth || (!method && !onAgy) || (onAgy && auth.programPending)) {
    return null
  }
  // On the host's agy, agy's own login serves this chat whatever Google method is saved; another
  // method moves new chats to Orca's server.
  const items = antigravityChatAuthMenuItems(auth.detection, auth.keyAndAdc).filter(
    (item) => !onAgy || item.method !== 'oauth-personal'
  )
  // The host's current version; a chat started before an upgrade runs the older one until it restarts.
  const program = antigravityProgramLabel(
    onAgy && auth.orcasAgy ? 'orcasAgy' : auth.backend,
    onAgy
      ? (auth.detection?.agyVersion ?? (auth.orcasAgy ? auth.managedVersion : null))
      : auth.managedVersion,
    t
  )
  const label = onAgy ? program : (antigravityChatAuthMethodLabel(method ?? '', t) ?? '')
  const project = method === 'agent-platform' ? auth.detection?.adc.project : null
  const shown = project ? `${label} · ${project}` : label
  const signsInWith = onAgy
    ? t('components.native-chat.antigravityAuth.agyItem', "agy's own login")
    : shown
  const Icon = onAgy || !method ? SquareTerminal : ICONS[method]
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
            { method: signsInWith }
          )}
          title={t(
            'components.native-chat.antigravityAuth.chipTitle',
            'Antigravity signs in with {{method}}',
            { method: signsInWith }
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
        <DropdownMenuRadioGroup value={onAgy ? AGY : (method ?? '')}>
          {onAgy ? (
            <DropdownMenuRadioItem value={AGY} onSelect={(event) => event.preventDefault()}>
              <span className="min-w-0 flex-1">
                {t('components.native-chat.antigravityAuth.agyItem', "agy's own login")}
                <span className="block text-2xs text-muted-foreground">
                  {t(
                    'components.native-chat.antigravityAuth.agyHint',
                    'This chat runs the Antigravity CLI on this host. Another method applies to new chats.'
                  )}
                </span>
              </span>
            </DropdownMenuRadioItem>
          ) : null}
          {items.map((item) => (
            <DropdownMenuRadioItem
              key={item.method}
              value={item.method}
              disabled={auth.switching !== null}
              onSelect={() => {
                if (item.active && !onAgy) {
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
        <p data-antigravity-program="" className="px-2 py-1.5 text-2xs text-muted-foreground">
          {t('components.native-chat.antigravityAuth.runsOn', 'Runs on: {{program}}', { program })}
        </p>
        <DropdownMenuItem onSelect={auth.openSettings}>
          <Settings2 className="size-3.5" aria-hidden />
          {t('components.native-chat.antigravityAuth.settings', 'Sign-in settings…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
