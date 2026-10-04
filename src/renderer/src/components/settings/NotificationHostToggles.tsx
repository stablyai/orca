import { ChevronDown, Server } from 'lucide-react'
import type { NotificationSourceId } from '../../../../shared/notification-source'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '../ui/collapsible'
import { Separator } from '../ui/separator'
import { NotificationSettingToggle } from './NotificationSettingToggle'
import { useNotificationSourceOptions } from './use-notification-source-options'
import { translate } from '@/i18n/i18n'

type NotificationHostTogglesProps = {
  mutedNotificationSourceIds: readonly NotificationSourceId[]
  disabled: boolean
  onChange: (hostId: NotificationSourceId, muted: boolean) => void
}

export function NotificationHostToggles({
  mutedNotificationSourceIds,
  disabled,
  onChange
}: NotificationHostTogglesProps): React.JSX.Element | null {
  const hostOptions = useNotificationSourceOptions()
  const mutedSourceIds = new Set(mutedNotificationSourceIds)
  const mutedCount = hostOptions.filter((host) => mutedSourceIds.has(host.id)).length
  // Keep an effective mute reachable after the last remote machine is removed.
  if (hostOptions.length <= 1 && mutedCount === 0) {
    return null
  }
  return (
    <>
      <Separator />
      <Collapsible>
        <CollapsibleTrigger variant="row">
          <span className="min-w-0 space-y-0.5">
            <span className="flex items-center gap-2">
              <Server className="size-4" />
              {translate('auto.components.settings.NotificationHostToggles.machines', 'Machines')}
            </span>
            <span className="block text-xs font-normal text-muted-foreground">
              {translate(
                'auto.components.settings.NotificationHostToggles.machinesDescription',
                'Choose which machines can show notifications on this computer. A paired server’s switch also covers work reached through it.'
              )}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {mutedCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.NotificationHostToggles.offCount',
                  '{{count}} off',
                  {
                    count: mutedCount
                  }
                )}
              </span>
            )}
            <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-4">
            {hostOptions.map((host) => (
              <NotificationSettingToggle
                key={host.id}
                label={host.label}
                description={host.detail}
                checked={!mutedSourceIds.has(host.id)}
                disabled={disabled}
                onToggle={() => onChange(host.id, !mutedSourceIds.has(host.id))}
              />
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </>
  )
}
