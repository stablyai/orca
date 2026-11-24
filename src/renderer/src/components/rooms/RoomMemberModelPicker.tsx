import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { runWithBusyFlag } from '@/lib/run-with-busy-flag'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { AgentSessionOptionsResult } from '../../../../shared/agent-session/options/protocol/agent-session-options-result'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { agentFromMemberId } from './RoomMemberAvatar'
import type { CatalogModel } from './room-model-catalog'
import { LOCAL, type RoomMember } from './room-types'

type MemberModel = {
  models: CatalogModel[]
  current: string | null
}

function catalogModels(result: AgentSessionOptionsResult): CatalogModel[] {
  return result.models.map((model) => ({
    id: model.id,
    label: model.label,
    isDefault: model.isDefault,
    ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
    efforts: model.efforts.map((effort) => ({
      value: effort.value,
      label: effort.label
    }))
  }))
}

/** A member's live session is the single source for its model list and next-turn model. */
export function RoomMemberModelPicker(props: { roomId: string; member: RoomMember }) {
  const t = useTranslate()
  const sessionId = props.member.sessionId
  const agent = agentFromMemberId(props.member.memberId)
  const [model, setModel] = useState<MemberModel | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!sessionId || !agent) {
      return
    }
    let live = true
    setModel(null)
    void callStructuredAgentSession<AgentSessionOptionsResult>(LOCAL, 'agentSession.options', {
      sessionId
    })
      .then((result) => {
        if (live) {
          setModel({ models: catalogModels(result), current: result.current.model ?? null })
        }
      })
      .catch(() => {
        if (live) {
          setModel({ models: [], current: null })
        }
      })
    return () => {
      live = false
    }
  }, [agent, sessionId])

  if (!sessionId || !agent) {
    return null
  }
  const current = model?.current ?? null
  const choices = model?.models ?? []
  const changeModel = async (value: string) => {
    if (!model || saving || value === current) {
      return
    }
    try {
      await runWithBusyFlag(setSaving, async () => {
        await callRuntimeRpc(LOCAL, 'orchestration.roomMemberSetModel', {
          id: props.roomId,
          memberId: props.member.memberId,
          model: value
        })
        setModel({ ...model, current: value })
        toast.success(t('auto.components.rooms.roster.modelUpdated', 'Model updated'))
      })
    } catch (error) {
      toast.error(
        `${t('auto.components.rooms.roster.modelUpdateFailed', 'Model update failed')}: ${
          (error as Error).message
        }`
      )
    }
  }

  return (
    <Select
      value={current ?? '_unknown'}
      onValueChange={(value) => void changeModel(value)}
      disabled={saving}
    >
      <SelectTrigger size="sm" className="mt-1 h-6 w-full text-xs">
        {saving ? <Loader2 className="size-3 animate-spin" /> : null}
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" position="popper">
        {!current ? (
          <SelectItem value="_unknown">
            {t('auto.components.rooms.roster.modelUnknown', '(unknown)')}
          </SelectItem>
        ) : null}
        {choices.map((choice) => (
          <SelectItem key={choice.id} value={choice.id}>
            {choice.label}
          </SelectItem>
        ))}
        {current && !choices.some((choice) => choice.id === current) ? (
          <SelectItem value={current}>{current}</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  )
}
