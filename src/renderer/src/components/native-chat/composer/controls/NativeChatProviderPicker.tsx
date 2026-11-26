import { chatSwitchPermissionCopy } from '../../../../../../shared/agent-session/options/permissions/provider-switch-permission-copy'
import { useMemo, useRef, useState } from 'react'
import { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import { chatAgentPickerEntry } from '@/components/agent/chat-agent-picker-entry'
import { useAgentMenuObservation } from '@/components/agent/launch-menu/use-new-tab-agent-menu-rows'
import { useAgentLaunchPickerInventory } from '@/components/agent/use-agent-launch-picker-inventory'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { useAgentDetectionTargetForWorktree } from '@/lib/agent-session/launch/inventory/useAgentDetectionTarget'
import { useTranslate } from '@/i18n/use-translate'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { isNativeChatAgent } from '../../../../../../shared/agent-launch/permissions/agent-chat-permission-support'
import { tuiAgentDisplayName } from '../../../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { isTuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent-config'
import {
  agentPickerDraft,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentSessionSelectProviderResult } from '../../../../../../shared/agent-session/lifecycle/records/agent-session-provider-selection'
import type {
  SessionOptionsSurface,
  SessionOptionDescriptor
} from '../../../../../../shared/native-chat/input/native-chat-session-options'
import type { NativeChatProviderPickerScope } from './native-chat-provider-picker-context'

const keys = ['model', 'effort', 'fastMode', 'serviceTier'] as const

function pickerOptions(snapshot: SessionOptionDescriptor[]): Record<string, string> {
  return Object.fromEntries(
    snapshot.flatMap(({ id, kind, fallbackModel }) => {
      if (!keys.some((key) => key === id)) {
        return []
      }
      const value = (id === 'model' ? fallbackModel : undefined) ?? kind.currentValue
      return value === undefined ? [] : [[id, String(value)]]
    })
  )
}

export function NativeChatProviderPicker({
  scope,
  active,
  surface,
  snapshot
}: {
  scope: NativeChatProviderPickerScope
  active: string
  surface: SessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
}) {
  const { workspaceId, selected, sessionId, target, onError } = scope
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const [open, setOpen] = useState(false)
  const [catalogAgent, setCatalogAgent] = useState<AgentPickerEntry['agent']>()
  const selecting = useRef(false)
  const agent = selected?.agent ?? active
  const detection = useAgentDetectionTargetForWorktree(workspaceId)
  const { model } = useAgentMenuObservation(workspaceId, open, detection)
  const inventory = useAgentLaunchPickerInventory(
    workspaceId,
    model,
    open,
    catalogAgent ?? (isTuiAgent(agent) ? agent : undefined)
  )
  const entries = useMemo(
    () =>
      inventory
        .filter((entry) => isNativeChatAgent(entry.agent))
        .map((entry) => chatAgentPickerEntry(entry)),
    [inventory]
  )
  const current = pickerOptions(snapshot)
  const { model: currentModel, ...options } = selected ? (selected.options ?? {}) : current
  const value: AgentPickerDraft | undefined = isTuiAgent(agent)
    ? {
        agent,
        surface: 'chat',
        choices: { ...(currentModel ? { model: currentModel } : {}), options }
      }
    : undefined
  const pick = async (next: AgentPickerEntry['agent'], draft?: AgentPickerDraft) => {
    const entry = entries.find((candidate) => candidate.agent === next)
    if (!entry?.surfaces.includes('chat')) {
      return
    }
    const choices =
      draft?.choices ?? (next !== active ? agentPickerDraft(entry, 'chat').choices : undefined)
    const values = {
      ...choices?.options,
      ...(choices?.model ? { model: choices.model } : {})
    }
    try {
      if (next === active && next === agent) {
        for (const key of keys) {
          const picked = values[key]
          if (picked !== undefined && picked !== current[key]) {
            await surface?.setOption(key, key === 'fastMode' ? picked === 'true' : picked)
          }
        }
        return
      }
      const params = {
        sessionId,
        agent: next,
        options: Object.fromEntries(
          keys.flatMap((key) => (values[key] ? [[key, values[key]]] : []))
        )
      }
      const result = await callStructuredAgentSession<AgentSessionSelectProviderResult>(
        target,
        'agentSession.selectProvider',
        params
      )
      if (result.status === 'consent-required') {
        const name = tuiAgentDisplayName(next) ?? next
        const allowed = await confirm({
          surface: 'security',
          title: t(
            'chat.providerSwitch.closestPermissionTitle',
            'Use the closest permission on {{agent}}?',
            { agent: name }
          ),
          description: chatSwitchPermissionCopy(result.from, result.fromPermission, next, t),
          confirmLabel: t('chat.providerSwitch.allow', 'Allow and switch'),
          initialFocus: 'cancel',
          aboveMenus: true,
          ignoresOpeningGesture: true
        })
        if (allowed) {
          const confirmed = await callStructuredAgentSession<AgentSessionSelectProviderResult>(
            target,
            'agentSession.selectProvider',
            {
              ...params,
              consent: {
                from: result.from,
                fromPermission: result.fromPermission,
                permission: 'full-access'
              }
            }
          )
          if (confirmed.status !== 'selected') {
            onError(
              t(
                'chat.providerSwitch.changed',
                'Chat permissions changed. Pick the agent again to continue.'
              )
            )
          }
        }
      }
    } catch {
      onError(t('chat.providerSwitch.failed', 'Couldn’t select this agent.'))
    }
  }
  return (
    <AgentLaunchPicker
      inline
      model={model}
      entries={entries}
      agent={value?.agent ?? null}
      value={value}
      selectAgentOnTab
      onOpenChange={setOpen}
      onCatalogOpen={setCatalogAgent}
      onPick={(next, draft) => {
        if (!selecting.current) {
          selecting.current = true
          void pick(next, draft).finally(() => {
            selecting.current = false
          })
        }
      }}
    />
  )
}
