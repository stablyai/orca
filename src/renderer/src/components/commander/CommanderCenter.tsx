import { X } from 'lucide-react'
import { Activity, useMemo, useState } from 'react'
import { dashboardBucketForDotState } from '@/components/dashboard/snapshot/dashboard-card-bucket'
import { AgentKanbanBoard } from '@/components/dashboard/board/AgentKanbanBoard'
import { revealDashboardAgent } from '@/components/dashboard/navigation/reveal-dashboard-agent'
import { useLiveDashboardSnapshot } from '@/components/dashboard/snapshot/useLiveDashboardSnapshot'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { DashboardSnapshot } from '../../../../shared/agent-status/presentation/dashboard-snapshot'
import { CommanderDecisionInbox } from './CommanderDecisionInbox'
import { CommanderProjectIndex } from './CommanderProjectIndex'
import { CommanderHostPicker } from './CommanderHostPicker'
import { CommanderChatAction } from './CommanderChatAction'
import { CommanderMemory } from './CommanderMemory'
import {
  cardHasCommanderActivity,
  projectCommanderAgents,
  type CommanderRepo,
  type CommanderActivity
} from './commander-project-overview'

export default function CommanderCenter(): React.JSX.Element {
  const repos = useAppStore((state) => state.repos)
  const snapshot = useLiveDashboardSnapshot()
  return <CommanderCenterView repos={repos} snapshot={snapshot} />
}

export function CommanderCenterView({
  repos,
  snapshot
}: {
  repos: readonly CommanderRepo[]
  snapshot: DashboardSnapshot
}): React.JSX.Element {
  const t = useTranslate()
  const [tab, setTab] = useState('overview')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [activity, setActivity] = useState<CommanderActivity>('all')
  const projects = useMemo(
    () => projectCommanderAgents(repos, snapshot.cards),
    [repos, snapshot.cards]
  )
  const selectedProject = projects.find((project) => project.id === projectId)
  const cards = selectedProject?.cards ?? snapshot.cards
  const boardSnapshot = useMemo(
    () => ({
      ...snapshot,
      cards:
        activity === 'all'
          ? cards
          : cards.filter((card) => cardHasCommanderActivity(card, activity)),
      showIdle: true,
      filterOptions: undefined
    }),
    [activity, cards, snapshot]
  )
  const buttons = [
    { id: 'all', label: t('commander.agents', 'All agents'), count: cards.length },
    {
      id: 'blocked',
      label: t('commander.blocked', 'Blocked'),
      count: selectedProject?.blocked ?? projects.reduce((sum, p) => sum + p.blocked, 0)
    },
    {
      id: 'waiting',
      label: t('commander.waiting', 'Waiting'),
      count: selectedProject?.waiting ?? projects.reduce((sum, p) => sum + p.waiting, 0)
    },
    {
      id: 'working',
      label: t('dashboardPopout.bucket.working', 'Working'),
      count: selectedProject?.working ?? projects.reduce((sum, p) => sum + p.working, 0)
    }
  ] as const

  return (
    <Tabs value={tab} onValueChange={setTab} className="h-full min-h-0 flex-1">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <h1 className="inline-block text-base font-semibold">
          {t('commander.title', 'Commander')}
        </h1>
        <TabsList size="sm" aria-label={t('commander.title', 'Commander')}>
          <TabsTrigger value="overview">{t('commander.overview', 'Overview')}</TabsTrigger>
          <TabsTrigger value="decisions">{t('commander.inboxTab', 'Decisions')}</TabsTrigger>
          <TabsTrigger value="handoffs">{t('commander.handoffs.tab', 'Handoffs')}</TabsTrigger>
          <TabsTrigger value="memory">{t('commander.memoryTab', 'Memory')}</TabsTrigger>
        </TabsList>
        <CommanderHostPicker />
        <CommanderChatAction />
        {tab === 'overview' && selectedProject && (
          <Button
            variant="outline"
            size="sm"
            className="max-w-72"
            onClick={() => setProjectId(null)}
            aria-label={t('commander.clearProject', 'Clear project filter')}
          >
            <span className="truncate">{selectedProject.name}</span>
            <X aria-hidden="true" />
          </Button>
        )}
      </header>
      <TabsContent value="overview" className="flex min-h-0 flex-col">
        <CommanderProjectIndex
          projects={projects}
          selectedProjectId={selectedProject?.id ?? null}
          activity={activity}
          onSelect={(id, selectedActivity) => {
            setProjectId(id)
            setActivity(selectedActivity)
          }}
        />
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          {buttons.map((button) => (
            <Button
              key={button.id}
              size="sm"
              variant={button.id === activity ? 'secondary' : 'ghost'}
              aria-pressed={button.id === activity}
              onClick={() => setActivity(button.id)}
            >
              {button.label}{' '}
              <span className="tabular-nums text-muted-foreground">{button.count}</span>
            </Button>
          ))}
        </div>
        {cards.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6">
            <p className="text-sm text-muted-foreground">
              {t('commander.noLiveAgents', 'No live agents in this view.')}
            </p>
            <Button variant="outline" size="sm" onClick={() => setTab('memory')}>
              {t('commander.viewSavedProgress', 'View saved project progress')}
            </Button>
          </div>
        ) : (
          <AgentKanbanBoard
            key={selectedProject?.id ?? 'all'}
            snapshot={boardSnapshot}
            focusedBucket={activity === 'all' ? undefined : dashboardBucketForDotState(activity)}
            containerClassName="min-h-0 flex-1"
            onAckAgent={(paneKey, intent) =>
              useAppStore.getState().acknowledgeAgents([paneKey], undefined, intent)
            }
            onRevealAgent={revealDashboardAgent}
          />
        )}
      </TabsContent>
      <TabsContent value="decisions" className="min-h-0">
        <CommanderDecisionInbox cards={snapshot.cards} />
      </TabsContent>
      <Activity mode={tab === 'handoffs' ? 'visible' : 'hidden'}>
        <TabsContent forceMount value="handoffs" className="min-h-0">
          <div className="scrollbar-sleek h-full overflow-auto">
            <CommanderMemory
              view="handoffs"
              projectId={selectedProject?.id ?? null}
              projectIds={projects.map((project) => project.id)}
            />
          </div>
        </TabsContent>
      </Activity>
      <Activity mode={tab === 'memory' ? 'visible' : 'hidden'}>
        <TabsContent forceMount value="memory" className="min-h-0">
          <div className="scrollbar-sleek h-full overflow-auto">
            <CommanderMemory
              projectId={selectedProject?.id ?? null}
              projectIds={projects.map((project) => project.id)}
              onClearProject={() => setProjectId(null)}
            />
          </div>
        </TabsContent>
      </Activity>
    </Tabs>
  )
}
