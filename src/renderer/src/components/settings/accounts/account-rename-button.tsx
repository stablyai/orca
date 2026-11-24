import { Loader2, Pencil } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import type { ProviderAccountRuntimeView } from '../../provider-accounts/provider-account-visibility'
import type { RenameAccountTarget } from './accounts-pane-types'

export function renameTargetFor(
  provider: RenameAccountTarget['provider'],
  account: { id: string; email: string; displayName?: string },
  runtime: ProviderAccountRuntimeView
): RenameAccountTarget {
  return {
    provider,
    id: account.id,
    email: account.email,
    displayName: account.displayName ?? null,
    runtime
  }
}

// Names never touch the sign-in, so signed-out and busy accounts stay renameable.

export function AccountRenameButton({
  disabled,
  pending,
  onRename,
  t = translate
}: {
  disabled: boolean
  pending: boolean
  onRename: () => void
  t?: Translate
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      size="xs"
      onClick={(event) => {
        event.stopPropagation()
        onRename()
      }}
      disabled={disabled || pending}
      className="h-6 px-2 text-muted-foreground hover:text-foreground"
    >
      {pending ? <Loader2 className="size-3 animate-spin" /> : <Pencil className="size-3" />}
      {t('accounts.rename.action', 'Rename')}
    </Button>
  )
}
