import { KeyRound, Cloud, LogIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
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

/** Detected methods first, each one click; then Google sign-in and Settings for everything else. */
export function NativeChatAntigravityAuthChooser({
  auth,
  alternatives
}: {
  auth: NativeChatAntigravityAuth
  alternatives: readonly AntigravityChatAuthAlternative[]
}): React.JSX.Element {
  const t = useTranslate()
  const busy = auth.switching !== null
  const detected = alternatives.length > 0
  return (
    <div className="space-y-2">
      {detected ? (
        <>
          <p className="text-xs text-muted-foreground">
            {t(
              'components.native-chat.antigravityAuth.foundLead',
              'Orca found credentials on this host you can use instead:'
            )}
          </p>
          <div className="flex flex-wrap gap-2">
            {alternatives.map((option, index) => {
              const Icon = ICONS[option.method]
              return (
                <Button
                  key={option.method}
                  type="button"
                  size="sm"
                  variant={index === 0 ? 'default' : 'outline'}
                  disabled={busy}
                  title={antigravityAlternativeHint(option, t)}
                  className="h-auto min-h-10 max-w-full flex-col items-start text-left whitespace-normal"
                  onClick={() => auth.switchTo(option.method)}
                >
                  <span className="flex items-center gap-1.5 font-medium">
                    {auth.switching === option.method ? (
                      <LoadingSpinner className="size-3.5" />
                    ) : (
                      <Icon className="size-3.5" aria-hidden />
                    )}
                    {antigravityAlternativeLabel(option, t)}
                  </span>
                  <span
                    className={
                      index === 0
                        ? 'text-2xs font-normal text-primary-foreground/80'
                        : 'text-2xs font-normal text-muted-foreground'
                    }
                  >
                    {antigravityAlternativeHint(option, t)}
                  </span>
                </Button>
              )
            })}
          </div>
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={detected ? 'outline' : 'default'}
          disabled={busy}
          onClick={auth.signInWithGoogle}
        >
          {t('components.native-chat.antigravityAuth.signInGoogle', 'Sign in with Google')}
        </Button>
        <Button type="button" size="sm" variant="link-muted" onClick={auth.openSettings}>
          {detected || !auth.keyAndAdc
            ? t('components.native-chat.antigravityAuth.moreOptions', 'More options…')
            : t('components.native-chat.antigravityAuth.useKeyOrGcloud', 'API key or gcloud')}
        </Button>
      </div>
    </div>
  )
}
