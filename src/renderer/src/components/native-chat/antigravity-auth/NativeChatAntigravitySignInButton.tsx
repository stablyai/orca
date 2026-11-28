import { ChevronDown, Cloud, KeyRound, LogIn, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatAntigravityAuth } from './native-chat-antigravity-auth'
import type { AntigravityChatAuthAlternative } from './antigravity-chat-auth-choices'
import { antigravityAlternativeHint, antigravityAlternativeLabel } from './antigravity-auth-words'

const ICONS = {
  'gemini-api-key': KeyRound,
  'agent-platform': Cloud,
  'oauth-personal': LogIn
} as const

/** Sign in with Google, the one main action; what Orca found and Settings wait in its menu. */
export function NativeChatAntigravitySignInButton({
  auth,
  alternatives,
  starting,
  disabled,
  onSignIn
}: {
  /** Absent where the chat has no sign-in context yet (a new bot's card): no menu then. */
  auth: NativeChatAntigravityAuth | null
  alternatives: readonly AntigravityChatAuthAlternative[]
  starting: boolean
  disabled: boolean
  onSignIn: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const busy = disabled || starting || (auth?.switching ?? null) !== null
  const label = t('components.native-chat.antigravityAuth.signInGoogle', 'Sign in with Google')
  const spinner = starting ? <LoadingSpinner className="size-3.5" /> : null
  if (!auth) {
    return (
      <Button type="button" size="sm" variant="outline-strong" disabled={busy} onClick={onSignIn}>
        {spinner}
        {label}
      </Button>
    )
  }
  // The launch picker's split: one strong-outline frame holding the action and its menu segment.
  return (
    <DropdownMenu>
      <div className="flex shrink-0 items-stretch overflow-hidden rounded-md border border-muted-foreground/75 bg-background shadow-xs dark:border-muted-foreground/60 dark:bg-input/30">
        <Button type="button" size="sm" variant="menu-launch" disabled={busy} onClick={onSignIn}>
          {spinner}
          {label}
        </Button>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon-sm"
            variant="menu-segment"
            disabled={busy}
            aria-label={t(
              'components.native-chat.antigravityAuth.otherWaysLabel',
              'Other ways to sign in'
            )}
          >
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </div>
      <DropdownMenuContent align="end" className="w-64">
        {alternatives.map((option) => {
          const Icon = ICONS[option.method]
          return (
            <DropdownMenuItem
              key={option.method}
              className="items-start"
              onSelect={() => auth.switchTo(option.method)}
            >
              <Icon className="mt-0.5 size-3.5 text-muted-foreground" aria-hidden />
              <span className="min-w-0">
                {antigravityAlternativeLabel(option, t)}
                <span className="block text-2xs text-muted-foreground">
                  {antigravityAlternativeHint(option, t)}
                </span>
              </span>
            </DropdownMenuItem>
          )
        })}
        {alternatives.length > 0 ? <DropdownMenuSeparator /> : null}
        <DropdownMenuItem onSelect={auth.openSettings}>
          <SlidersHorizontal className="size-3.5 text-muted-foreground" aria-hidden />
          {t('components.native-chat.antigravityAuth.otherWaysMenu', 'Other ways to sign in…')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
