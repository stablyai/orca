import { ServerCog } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import type { ProviderAccountScope, ProviderRateLimitScope } from './provider-account-scope'
import { translate } from '@/i18n/i18n'

type ProviderHostScopeControlProps = {
  labelPrefix: string
  scope: ProviderAccountScope | ProviderRateLimitScope
  className?: string
}

export function ProviderHostScopeControl({
  labelPrefix,
  scope,
  className
}: ProviderHostScopeControlProps): React.JSX.Element {
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)

  const openHostsSettings = (): void => {
    openSettingsPage()
    openSettingsTarget({ pane: 'servers', repoId: null, sectionId: 'default-runtime' })
  }

  return (
    <div className={className}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* Why: integration cards can become narrow while Settings navigation
        remains visible, so the action must wrap before scope copy collapses. */}
        <div className="min-w-[min(14rem,100%)] flex-1">
          <span className="font-medium text-foreground">
            {translate(
              'auto.components.settings.ProviderHostScopeControl.scope_label',
              '{{value0}}: {{value1}}',
              { value0: labelPrefix, value1: scope.label }
            )}
          </span>
          <div className="mt-0.5 text-muted-foreground">{scope.description}</div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={openHostsSettings}
        >
          <ServerCog className="size-3.5" />
          {translate(
            'auto.components.settings.ProviderHostScopeControl.change_host',
            'Open Remote Servers'
          )}
        </Button>
      </div>
    </div>
  )
}
