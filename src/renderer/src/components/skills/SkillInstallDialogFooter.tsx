import { Download, Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import type { SkillInstallResult } from '../../../../shared/skill-install-contract'
import { translate } from '@/i18n/i18n'

type SkillInstallDialogFooterProps = {
  activeOperationId: string | null
  busy: boolean
  hasBundleVersion: boolean
  hasPreview: boolean
  link: string
  resolvingInitialLink: boolean
  result: SkillInstallResult | null
  scope: 'global' | 'workspace'
  workspace: string
  onCancelInstall: () => void
  onClose: () => void
  onInspect: () => void
  onInstall: (discardLocal?: boolean) => void
}

export function SkillInstallDialogFooter({
  activeOperationId,
  busy,
  hasBundleVersion,
  hasPreview,
  link,
  resolvingInitialLink,
  result,
  scope,
  workspace,
  onCancelInstall,
  onClose,
  onInspect,
  onInstall
}: SkillInstallDialogFooterProps): React.JSX.Element | null {
  if (hasBundleVersion) {
    return null
  }

  return (
    <DialogFooter>
      <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
        {translate('auto.components.skills.SkillInstallDialog.d198ec91e5', 'Close')}
      </Button>
      {!hasPreview && !resolvingInitialLink ? (
        <Button type="button" disabled={busy || !link.trim()} onClick={onInspect}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
          {busy
            ? translate('auto.components.skills.SkillInstallReviewContent.69236de8d6', 'Checking…')
            : translate(
                'auto.components.skills.SkillInstallReviewContent.157de228b4',
                'Inspect skill'
              )}
        </Button>
      ) : null}
      {busy && activeOperationId ? (
        <Button type="button" variant="secondary" onClick={onCancelInstall}>
          {translate('auto.components.skills.SkillInstallDialog.05588076a9', 'Cancel installation')}
        </Button>
      ) : null}
      {hasPreview &&
      (!result || ['conflict', 'partial', 'failed', 'cancelled'].includes(result.status)) ? (
        <Button
          type="button"
          disabled={busy || (scope === 'workspace' && !workspace)}
          onClick={() => onInstall()}
          className="w-32"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
          {busy
            ? translate('auto.components.skills.SkillInstallDialog.241e72f9d6', 'Installing…')
            : result
              ? translate('auto.components.skills.SkillInstallDialog.59c3b76cdd', 'Retry install')
              : translate('auto.components.skills.SkillInstallDialog.39acb9e8f4', 'Install skill')}
        </Button>
      ) : null}
    </DialogFooter>
  )
}
