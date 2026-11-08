import { ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import type {
  DeveloperPermissionId,
  DeveloperPermissionStatus
} from '../../../../../shared/developer-permissions-types'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'

type DeveloperPermissionActionsProps = {
  id: DeveloperPermissionId
  actionLabel: string
  pending: boolean
  status: DeveloperPermissionStatus | undefined
  onRequest: (id: DeveloperPermissionId) => void
}

export function DeveloperPermissionActions({
  id,
  actionLabel,
  pending,
  status,
  onRequest
}: DeveloperPermissionActionsProps): React.JSX.Element {
  const t = useTranslate()
  const openSettings = async (): Promise<void> => {
    try {
      await window.api.developerPermissions.openSettings({ id })
    } catch {
      toast.error(
        t(
          'auto.components.settings.DeveloperPermissionsPane.openSettingsFailed',
          'Could not open System Settings'
        )
      )
    }
  }

  return (
    <div className="flex shrink-0 gap-2">
      <Button
        variant={id === 'local-network' ? 'default' : 'outline'}
        size="sm"
        disabled={pending || status === 'unsupported'}
        onClick={() => onRequest(id)}
        className="gap-1.5"
      >
        <ExternalLink className="size-3.5" />
        {pending
          ? t('auto.components.settings.DeveloperPermissionsPane.dac08ec03e', 'Working...')
          : actionLabel}
      </Button>
      {id === 'local-network' && (
        <Button variant="outline" size="sm" onClick={() => void openSettings()}>
          {t(
            'auto.components.settings.DeveloperPermissionsPane.localNetworkOpenSystemSettings',
            'Open System Settings'
          )}
        </Button>
      )}
    </div>
  )
}
