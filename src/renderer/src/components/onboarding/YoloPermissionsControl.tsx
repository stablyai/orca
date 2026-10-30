import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import {
  applyAgentPermissionOverrides,
  PERMISSION_CHOICE_AGENTS
} from '../../../../shared/tui-agent-permission-choice'
import type { TuiAgent } from '../../../../shared/tui-agent'

export function YoloPermissionsControl({
  yoloPermissions,
  onYoloPermissionsChange
}: {
  yoloPermissions: boolean
  onYoloPermissionsChange?: (enabled: boolean) => void
}): React.JSX.Element {
  const switchId = useId()
  const overrides = useAppStore((s) => s.settings?.agentPermissionOverrides)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)
  const fullAccessAgents = PERMISSION_CHOICE_AGENTS.filter(
    (agent) => overrides?.[agent] === 'full-access'
  )
  const handleUseOwnSettings = async (agent: TuiAgent): Promise<void> => {
    setSaving(true)
    setError(false)
    try {
      const { settings, updateSettingsOrThrow } = useAppStore.getState()
      if (!settings) {
        throw new Error('Settings unavailable')
      }
      await updateSettingsOrThrow(applyAgentPermissionOverrides(settings, [agent], 'own'))
    } catch {
      setError(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="shrink-0 space-y-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-6">
        <label htmlFor={switchId} className="min-w-0 cursor-pointer space-y-0.5">
          <span className="block text-sm font-medium text-foreground">
            {translate('auto.components.onboarding.AgentStep.yoloModeLabel', 'Yolo mode')}
          </span>
          <span className="block text-xs text-muted-foreground">
            {translate(
              'auto.components.onboarding.AgentStep.yoloPermissionsDescription',
              'Agents run commands and edit files without asking, and some also bypass their sandbox. Use only in projects you trust.'
            )}
          </span>
        </label>
        <Switch
          id={switchId}
          checked={yoloPermissions}
          disabled={saving}
          onCheckedChange={(checked) => onYoloPermissionsChange?.(checked)}
        />
      </div>
      {!yoloPermissions && fullAccessAgents.length > 0 && (
        <div
          role="status"
          className="scrollbar-sleek max-h-48 space-y-3 overflow-y-auto rounded-lg border border-status-warning-border bg-status-warning-background px-4 py-3 text-xs text-foreground"
        >
          <p>
            {translate(
              'components.onboarding.yoloPermissions.overrideDescription',
              'These agents can still run commands and edit files without asking. Their individual settings override Yolo mode.'
            )}
          </p>
          {fullAccessAgents.map((agent) => (
            <div key={agent} className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">
                {translate(
                  'components.onboarding.yoloPermissions.fullAccessOverride',
                  '{{agent}} still has full access',
                  { agent: getAgentLabel(agent) }
                )}
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={saving}
                aria-label={translate(
                  'components.onboarding.yoloPermissions.useAgentOwnSettings',
                  'Use {{agent}}’s own settings',
                  { agent: getAgentLabel(agent) }
                )}
                onClick={() => void handleUseOwnSettings(agent)}
              >
                {translate(
                  'components.onboarding.yoloPermissions.useOwnSettings',
                  'Use own settings'
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'components.onboarding.yoloPermissions.saveError',
            'Could not change permissions. Try again.'
          )}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {translate(
          'components.onboarding.yoloPermissions.ownSettingsDescription',
          'Off uses each agent’s own settings. Individual agent permissions can override this switch.'
        )}
      </p>
    </div>
  )
}
