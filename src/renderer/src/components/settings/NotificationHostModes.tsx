import { useEffect, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { AGENT_SESSION_FLOW_ATTENTION_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-attention-capabilities'
import { pickerExecutionHosts } from '../../../../shared/managed-orcad-execution-host'
import type { ExecutionHostRegistryEntry } from '../../../../shared/execution-host-registry'
import { translate } from '@/i18n/i18n'
import { useNotificationSourceOptions } from './use-notification-source-options'
import { SettingsRow } from './SettingsFormControls'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

type Mode = 'current' | 'action-or-flow-complete'

function HostMode({ host }: { host: ExecutionHostRegistryEntry }): React.JSX.Element {
  const target = [host.id, ...(host.aliasHostIds ?? [])]
    .map(parseExecutionHostId)
    .find((id) => id?.kind === 'runtime')
  const environmentId = target?.kind === 'runtime' ? target.environmentId : undefined
  const supported =
    host.capabilities?.includes(AGENT_SESSION_FLOW_ATTENTION_RUNTIME_CAPABILITY) === true
  const [saved, setSaved] = useState<{ environmentId: string; mode: Mode } | null>(null)
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!environmentId || !supported) {
      return
    }
    let active = true
    void callRuntimeRpc<{ settings: { agentNotificationMode?: Mode } }>(
      { kind: 'environment', environmentId },
      'settings.get',
      undefined
    ).then(
      (result) => {
        if (active) {
          setSaved({ environmentId, mode: result.settings.agentNotificationMode ?? 'current' })
        }
      },
      () => {
        if (active) {
          setFailed(true)
        }
      }
    )
    return () => {
      active = false
    }
  }, [environmentId, supported])
  const save = async (mode: Mode): Promise<void> => {
    if (!environmentId) {
      return
    }
    setSaving(true)
    setFailed(false)
    try {
      const result = await callRuntimeRpc<{ settings: { agentNotificationMode?: Mode } }>(
        { kind: 'environment', environmentId },
        'settings.update',
        { agentNotificationMode: mode }
      )
      setSaved({ environmentId, mode: result.settings.agentNotificationMode ?? 'current' })
    } catch {
      setFailed(true)
    } finally {
      setSaving(false)
    }
  }
  return (
    <SettingsRow
      label={host.label}
      description={
        !supported || !environmentId
          ? translate(
              'notifications.agentMode.updateHost',
              'Update this host to use whole-flow notifications'
            )
          : failed
            ? translate(
                'notifications.agentMode.hostFailed',
                'Could not read or save this host’s notification mode.'
              )
            : translate(
                'notifications.agentMode.hostDescription',
                'Notification mode saved on this execution host for phone delivery.'
              )
      }
      control={
        supported && environmentId ? (
          <Select
            value={saved?.environmentId === environmentId ? saved.mode : 'current'}
            disabled={saving || saved?.environmentId !== environmentId}
            onValueChange={(value) => {
              if (value === 'current' || value === 'action-or-flow-complete') {
                void save(value)
              }
            }}
          >
            <SelectTrigger className="w-80" aria-label={host.label}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current">
                {translate('notifications.agentMode.current', 'Current behavior')}
              </SelectItem>
              <SelectItem value="action-or-flow-complete">
                {translate(
                  'notifications.agentMode.wholeFlow',
                  'User action or whole flow complete'
                )}
              </SelectItem>
            </SelectContent>
          </Select>
        ) : null
      }
    />
  )
}

export function NotificationHostModes(): React.JSX.Element {
  const hosts = pickerExecutionHosts(useNotificationSourceOptions()).filter(
    (host) => host.kind !== 'local'
  )
  return (
    <>
      {hosts.map((host) => (
        <HostMode key={host.id} host={host} />
      ))}
    </>
  )
}
