import { ChevronDown, Link, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { canCopyClaudeSignInLink } from '../../../../shared/claude-sign-in-link'
import { Button } from '../ui/button'
import { ButtonGroup } from '../ui/button-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

export function canOfferClaudeSignInLink(runtime: 'host' | 'wsl' | undefined): boolean {
  return canCopyClaudeSignInLink(navigator.userAgent.includes('Windows'), runtime)
}

/** With `copyLink`, copies the just-started sign-in's link once Claude hands it over. */
export function withCopiedClaudeLink(
  copyLink: boolean,
  signIn: Promise<ClaudeRateLimitAccountsState>
): Promise<ClaudeRateLimitAccountsState> {
  if (!copyLink) {
    return signIn
  }
  void window.api.claudeAccounts
    .waitForSignInLink()
    .then(async (link) => {
      if (!link) {
        return
      }
      await window.api.ui.writeClipboardText(link)
      toast.success(
        translate(
          'accounts.claude.signInLinkCopied',
          'Sign-in link copied. Open it in a private window to sign in with a different account.'
        )
      )
    })
    .catch((error: unknown) => {
      console.warn('Could not copy the Claude sign-in link:', error)
      toast.error(translate('accounts.claude.signInLinkCopyFailed', 'Could not copy the link.'))
    })
  return signIn
}

export function ClaudeSignInLinkMenu({
  variant,
  disabled,
  onCopyLink
}: {
  variant: 'outline' | 'ghost'
  disabled: boolean
  onCopyLink: () => void
}): React.JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={variant}
          size="icon-xs"
          disabled={disabled}
          aria-label={translate('accounts.claude.moreSignInOptions', 'More sign-in options')}
        >
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onCopyLink}>
          <Link />
          {translate('accounts.claude.copySignInLink', 'Copy sign-in link instead')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A saved account's sign-in button, with the copy-link option where Claude supports it. */
export function ClaudeSignInAgainButtons({
  runtime,
  disabled,
  signingIn,
  onSignIn
}: {
  runtime: 'host' | 'wsl' | undefined
  disabled: boolean
  signingIn: boolean
  onSignIn: (copyLink: boolean) => void
}): React.JSX.Element {
  return (
    <ButtonGroup>
      <Button
        variant="ghost"
        size="xs"
        onClick={(event) => {
          event.stopPropagation()
          onSignIn(false)
        }}
        disabled={disabled}
        className="h-6 px-2 text-muted-foreground hover:text-foreground"
      >
        {signingIn ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
        {translate('accounts.claude.signInAgain', 'Sign in again')}
      </Button>
      {canOfferClaudeSignInLink(runtime) ? (
        <ClaudeSignInLinkMenu
          variant="ghost"
          disabled={disabled}
          onCopyLink={() => onSignIn(true)}
        />
      ) : null}
    </ButtonGroup>
  )
}
