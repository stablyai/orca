import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentLaunchSettings,
  AgentLaunchSettingsMutation
} from '../../../../shared/agent-launch-settings'
import type { AgentPermissionsRenderer } from './AgentLaunchSettingsCatalog'
import { AgentLaunchSettingsCatalog } from './AgentLaunchSettingsCatalog'
import {
  mutateHostAgentLaunchSettings,
  readHostAgentLaunchSettings,
  type AgentLaunchSettingsOwner
} from './agent-launch-settings-transport'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

type ReadState =
  | { kind: 'loading' | 'unsupported' | 'failed' }
  | { kind: 'ready'; settings: AgentLaunchSettings }

export function HostAgentLaunchSettings({
  environmentId,
  pairingRevision,
  hostName,
  renderPermissions
}: AgentLaunchSettingsOwner & {
  hostName: string
  renderPermissions: AgentPermissionsRenderer
}): React.JSX.Element {
  const owner = useMemo(
    () => ({ environmentId, pairingRevision }),
    [environmentId, pairingRevision]
  )
  const detectionTarget = useMemo(
    () => ({ kind: 'runtime' as const, environmentId }),
    [environmentId]
  )
  const controllerRef = useRef<AbortController | null>(null)
  const [read, setRead] = useState<ReadState>({ kind: 'loading' })
  const [saveFailed, setSaveFailed] = useState(false)
  const mutationTail = useRef<Promise<void> | null>(null)
  const refresh = useCallback(async (): Promise<void> => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setRead({ kind: 'loading' })
    try {
      const settings = await readHostAgentLaunchSettings(owner, controller.signal)
      if (!controller.signal.aborted) {
        setRead(settings ? { kind: 'ready', settings } : { kind: 'unsupported' })
      }
    } catch {
      if (!controller.signal.aborted) {
        setRead({ kind: 'failed' })
      }
    }
  }, [owner])
  useEffect(() => {
    void refresh()
    return () => controllerRef.current?.abort()
  }, [refresh])
  const mutate = async (mutation: AgentLaunchSettingsMutation): Promise<void> => {
    const controller = controllerRef.current
    if (!controller || controller.signal.aborted || read.kind !== 'ready') {
      throw new Error('agent_launch_settings_unavailable')
    }
    const write = (mutationTail.current ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        if (controller.signal.aborted) {
          throw new Error('agent_launch_settings_unavailable')
        }
        setSaveFailed(false)
        try {
          const settings = await mutateHostAgentLaunchSettings(owner, mutation, controller.signal)
          if (!controller.signal.aborted) {
            setRead({ kind: 'ready', settings })
          }
        } catch {
          if (!controller.signal.aborted) {
            setSaveFailed(true)
          }
          throw new Error('agent_launch_settings_save_failed')
        }
      })
    mutationTail.current = write
    return write
  }
  if (read.kind !== 'ready') {
    return (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>
          {read.kind === 'loading'
            ? translate('settings.agents.loadingHost', 'Loading agent settings…')
            : read.kind === 'unsupported'
              ? translate(
                  'settings.agents.updateHost',
                  'Update this server to edit its agent launch settings.'
                )
              : translate(
                  'settings.agents.readFailed',
                  'Couldn’t read agent settings. Check the host connection and try again.'
                )}
        </p>
        {read.kind === 'failed' ? (
          <Button type="button" variant="ghost" size="xs" onClick={() => void refresh()}>
            {translate('auto.components.settings.AgentsPane.retryDetection', 'Retry')}
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <div className="space-y-3">
      <fieldset className="min-w-0 space-y-8">
        <AgentLaunchSettingsCatalog
          settings={read.settings}
          mutate={mutate}
          detectionTarget={detectionTarget}
          hostName={hostName}
          renderPermissions={renderPermissions}
          refreshSettings={() => void refresh()}
        />
      </fieldset>
      {saveFailed ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'settings.agents.saveFailed',
            'Couldn’t save agent settings. Check the host connection and try again.'
          )}
        </p>
      ) : null}
    </div>
  )
}
