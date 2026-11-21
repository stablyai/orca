import type { AgentLaunchSetupPanelProps } from './AgentLaunchSetupPanel'
import { useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { structuredAgentSessionTargetForHost } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'

export function KiroChatAgentSetup({
  entry,
  draft,
  getDraft,
  disabled,
  onDraftChange
}: Pick<
  AgentLaunchSetupPanelProps,
  'entry' | 'draft' | 'getDraft' | 'disabled' | 'onDraftChange'
>) {
  const target = entry.draftTarget
  if (entry.agent !== 'kiro' || !entry.surfaces.includes('chat') || !target?.worktreeId) {
    return null
  }
  return (
    <KiroChatAgentField
      key={target.key}
      host={target.executionHostId}
      workspace={target.worktreeId}
      value={draft.kiroChatAgent}
      disabled={disabled}
      onSelect={(kiroChatAgent) => {
        const current = getDraft()
        if (current) {
          onDraftChange({ ...current, kiroChatAgent }, 'choice')
        }
      }}
    />
  )
}

function KiroChatAgentField({
  host,
  workspace,
  value,
  disabled,
  onSelect
}: {
  host: string
  workspace: string
  value?: string
  disabled?: boolean
  onSelect: (name?: string) => void
}) {
  const t = useTranslate()
  const [names, setNames] = useState<string[]>([])
  useEffect(() => {
    const target = structuredAgentSessionTargetForHost(host)
    if (!target) {
      return
    }
    const request = new AbortController()
    void callStructuredAgentSession<{ kiroAgents?: string[] }>(
      target,
      'agentSession.createSupport',
      { worktree: `id:${workspace}`, agent: 'kiro', listKiroAgents: true }
    )
      .then((reply) => {
        if (!request.signal.aborted) {
          setNames(reply.kiroAgents ?? [])
        }
      })
      .catch((error: unknown) => {
        if (!request.signal.aborted) {
          console.warn('[kiro] Agent listing unavailable', error)
        }
      })
    return () => request.abort()
  }, [host, workspace])
  if (!names.length && !value) {
    return null
  }
  const label = t('agentPicker.kiroChatAgent', 'Chat agent')
  return (
    <div className="flex min-h-9 items-center justify-between gap-2 border-t border-border px-2.5 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Select
        value={value ? `agent:${value}` : 'default'}
        disabled={disabled}
        onValueChange={(choice) => onSelect(choice === 'default' ? undefined : choice.slice(6))}
      >
        <SelectTrigger size="sm" density="compact" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">
            {t('agentPicker.kiroDefaultAgent', 'Kiro default')}
          </SelectItem>
          {(value && !names.includes(value) ? [value, ...names] : names).map((name) => (
            <SelectItem key={name} value={`agent:${name}`}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
