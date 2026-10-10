import { GitPullRequestArrow, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function UpdateBranchButton({
  updating,
  disabled,
  onUpdate
}: {
  updating: boolean
  disabled: boolean
  onUpdate: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      className="w-full"
      disabled={disabled || updating}
      aria-busy={updating}
      onClick={onUpdate}
    >
      {updating ? <Loader2 className="animate-spin" /> : <GitPullRequestArrow />}
      {updating
        ? translate('auto.components.right.sidebar.UpdateBranch.updating', 'Updating…')
        : translate('auto.components.right.sidebar.UpdateBranch.label', 'Update branch')}
    </Button>
  )
}
