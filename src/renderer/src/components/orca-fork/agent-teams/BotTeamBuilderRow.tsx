// orca-fork: Bot settings › "Can build a team". Hidden on a host whose server has no agent teams.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { UsersRound } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { callBotRpc, type BotRef } from '@/lib/bot-hosts'
import type { Bot } from '../../../../../shared/bot-types'
import { FORK_FEATURES } from '../../../../../shared/orca-fork/fork-features'
import {
  AGENT_TEAMS_GET_METHOD,
  AGENT_TEAMS_SET_METHOD,
  type AgentTeamView
} from '../../../../../shared/orca-fork/agent-teams'
import { SettingsInsetRow } from '../../bots/settings-view/BotSettingsRows'

export function BotTeamBuilderRow({ bot }: { bot: Bot }): React.JSX.Element | null {
  const t = useTranslate()
  const [team, setTeam] = useState<AgentTeamView | null>(null)
  const { id, hostId } = bot
  const ref = useMemo<BotRef>(() => ({ id, hostId }), [id, hostId])
  useEffect(() => {
    let live = true
    setTeam(null)
    callBotRpc<AgentTeamView>(ref, AGENT_TEAMS_GET_METHOD, { botId: id })
      .then((view) => live && setTeam(view))
      .catch(() => live && setTeam(null))
    return () => {
      live = false
    }
  }, [ref])
  const toggle = useCallback(
    (teamBuilder: boolean) => {
      setTeam((previous) => (previous ? { ...previous, teamBuilder } : previous))
      void callBotRpc<AgentTeamView>(ref, AGENT_TEAMS_SET_METHOD, {
        botId: id,
        teamBuilder
      })
        .then(setTeam)
        .catch(() =>
          setTeam((previous) => (previous ? { ...previous, teamBuilder: !teamBuilder } : previous))
        )
    },
    [ref]
  )
  if (!FORK_FEATURES.agentTeams || !team) {
    return null
  }
  const title = t('orcaFork.teams.builder', 'Can build a team')
  return (
    <SettingsInsetRow
      icon={<UsersRound />}
      title={title}
      detail={t(
        'orcaFork.teams.builderDetail',
        'Creates the bots it proposes without asking you (up to {{cap}} a day) and shares a group with them. They hand work to each other without your approval.',
        { cap: team.dailyCap }
      )}
      wrapDetail
      end={<Switch checked={team.teamBuilder} aria-label={title} onCheckedChange={toggle} />}
    />
  )
}
