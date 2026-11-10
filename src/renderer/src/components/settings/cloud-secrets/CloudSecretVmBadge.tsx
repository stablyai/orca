import { TriangleAlert } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cloudSecretStoredOnVm } from '../../../../../shared/cloud-secrets/cloud-secret-rules'
import { Badge } from '../../ui/badge'

/** Marks a key the workspace VM holds in full (it can't be swapped at egress), never silently. */
export function CloudSecretVmBadge({ name }: { name: string }): React.JSX.Element | null {
  const t = useTranslate()
  if (!cloudSecretStoredOnVm(name)) {
    return null
  }
  const why = cloudSecretVmWarning(t)
  return (
    <Badge variant="referenceLabel" title={why}>
      <TriangleAlert aria-hidden />
      {t('cloudSecrets.vm.badge', 'Stored on workspace')}
      <span className="sr-only">{why}</span>
    </Badge>
  )
}

export function cloudSecretVmWarning(t: ReturnType<typeof useTranslate>): string {
  return t(
    'cloudSecrets.vm.warning',
    'Orca can’t swap this key at the network edge, so cloud workspaces get the real value. Anything running in the workspace can read it.'
  )
}
