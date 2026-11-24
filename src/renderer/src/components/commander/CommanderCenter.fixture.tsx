import { defineFixture } from '../../component-fixtures/component-fixture'
import type { DashboardCard } from '../../../../shared/agent-status/presentation/dashboard-snapshot'
import { CommanderCenterView } from './CommanderCenter'

const names = [
  'payments',
  'client',
  'mobile',
  'gateway',
  'api',
  'docs',
  'search',
  'identity',
  'events',
  'web',
  'models',
  'workers'
]
const repos = names.map((name) => ({
  id: name,
  displayName: name,
  upstream: { owner: 'fleet', repo: name }
}))
const cards = Array.from({ length: 300 }, (_, index): DashboardCard => {
  const repo = repos[index % repos.length]
  const dotState =
    index % 7 === 0 ? 'blocked' : index % 5 === 0 ? 'waiting' : index % 4 === 0 ? 'done' : 'working'
  return {
    repoId: repo.id,
    repoName: repo.displayName,
    worktreeId: `worktree-${index}`,
    worktreeName: `release-${index + 1}`,
    paneKey: `agent-${index}`,
    ptyId: null,
    tabId: `tab-${index}`,
    leafId: null,
    agentType: index % 2 === 0 ? 'codex' : 'claude',
    task: [
      'Run interface checks',
      'Verify release notes',
      'Update client bindings',
      'Review integration tests'
    ][index % 4],
    dotState,
    bucket: dotState === 'blocked' || dotState === 'waiting' ? 'attention' : dotState,
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: true,
    askSummary: dotState === 'blocked' ? 'Choose a release target' : undefined
  }
})

export const fleet300 = defineFixture({
  width: 1280,
  render: () => (
    <div style={{ height: 820 }}>
      <CommanderCenterView repos={repos} snapshot={{ generatedAt: 0, cards }} />
    </div>
  )
})
