import { ChevronDown, Link } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ClaudeRateLimitAccountsState } from '../../../../shared/managed-account-types'
import { canCopyClaudeSignInLink } from '../../../../shared/claude-sign-in-link'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

/** Whether Settings offers "Copy sign-in link instead" for a sign-in in `runtime`. */
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

/** The ▾ beside Add Account and Sign in again. */
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
