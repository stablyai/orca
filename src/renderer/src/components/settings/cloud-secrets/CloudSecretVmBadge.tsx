import { TriangleAlert } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cloudSecretStoredOnVm } from '../../../../../shared/cloud-secrets/cloud-secret-rules'
import { Badge } from '../../ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'

/**
 * Marks a key the sandbox holds in full (it can't be swapped at egress), never silently. Focusable,
 * so keyboard users reach the reason through the shared tooltip; screen readers get it inline.
 */
export function CloudSecretVmBadge({ name }: { name: string }): React.JSX.Element | null {
  const t = useTranslate()
  if (!cloudSecretStoredOnVm(name)) {
    return null
  }
  const why = cloudSecretVmWarning(t)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The focus target is the wrapper: Badge owns its shape. */}
        <span
          tabIndex={0}
          className="inline-flex rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <Badge variant="referenceLabel">
            <TriangleAlert aria-hidden className="text-status-warning" />
            {t('cloudSecrets.vm.badge', 'Real value in sandbox')}
            <span className="sr-only">{why}</span>
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className="max-w-72">
        {why}
      </TooltipContent>
    </Tooltip>
  )
}

export function cloudSecretVmWarning(t: ReturnType<typeof useTranslate>): string {
  return t(
    'cloudSecrets.vm.warning',
    'Orca can’t swap AWS keys at the network edge, so cloud workspaces get the real value. Anything running in the sandbox can read it.'
  )
}
