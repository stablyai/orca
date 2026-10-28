import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import russian from '@/i18n/test-resources/runtime-source-grammar.json'
import type { DashboardAgentRow as DashboardAgentRowData } from '@/components/dashboard/useDashboardData'
import {
  formatSummaryAgentCount,
  formatSummaryStateLabel,
  getAgentDotState,
  summarizeAgentIdentities,
  summarizeAgents
} from './worktree-card-agent-summary'
import { buildSubagentChildRows } from './worktree-subagent-child-rows'

function monitoringAgent(): DashboardAgentRowData {
  return {
    paneKey: 'tab-1:leaf-1',
    state: 'working',
    agentType: 'claude',
    startedAt: 1,
    tab: {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    },
    entry: {
      state: 'working',
      workingMode: 'monitoring',
      prompt: '',
      updatedAt: 1,
      stateStartedAt: 1,
      stateHistory: [],
      paneKey: 'tab-1:leaf-1'
    }
  }
}

describe('worktree card agent summary', () => {
  it('keeps a subagent row on its own state while its failed main agent reads failed', () => {
    const parent = monitoringAgent()
    parent.entry = {
      ...parent.entry,
      workingMode: undefined,
      mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: 1 },
      subagents: [{ id: 'child-1', state: 'working', startedAt: 1 }]
    }
    const [child] = buildSubagentChildRows({
      parentEntry: parent.entry,
      tab: parent.tab,
      parentIsFresh: true
    })

    expect(getAgentDotState(parent)).toBe('failed')
    expect(getAgentDotState(child)).toBe('working')
  })
})

describe('localized worktree card agent summaries', () => {
  beforeEach(async () => {
    i18n.addResourceBundle('ru', 'translation', russian, true, true)
    await i18n.changeLanguage('ru')
  })
  afterEach(async () => {
    await i18n.changeLanguage('en')
  })

  it.each([
    [0, '0 агентов'],
    [1, '1 агент'],
    [2, '2 агента'],
    [5, '5 агентов'],
    [21, '21 агент']
  ] as const)('localizes the count and whole summary for %i agents', (count, label) => {
    expect(formatSummaryAgentCount(count)).toBe(label)
    const agents = Array.from({ length: count }, monitoringAgent)
    if (count === 1) {
      expect(summarizeAgents(agents, label)).toBe('1 агент: наблюдение')
    }
    if (count > 1) {
      expect(summarizeAgents(agents, label)).toBe(`Все (${label}): наблюдение`)
    }
  })

  it('localizes every app-owned summary state and keeps agent brands intact', () => {
    const states = [
      ['waiting', 'ожидание'],
      ['blocked', 'блокировка'],
      ['interrupted', 'прервано'],
      ['failed', 'ошибка'],
      ['working', 'работа'],
      ['monitoring', 'наблюдение'],
      ['done', 'готово'],
      ['idle', 'бездействие'],
      ['unverifiable', 'нет данных'],
      ['unconfirmed', 'не подтверждено'],
      ['permission', 'требуется внимание']
    ] as const
    for (const [state, expected] of states) {
      expect(formatSummaryStateLabel(state)).toBe(expected)
    }
    expect(summarizeAgentIdentities([monitoringAgent()])).toBe('Claude: наблюдение')
    const unknown = { ...monitoringAgent(), agentType: 'unknown' as const }
    expect(summarizeAgentIdentities([unknown])).toBe('Агент: наблюдение')
    const done = monitoringAgent()
    done.state = 'done'
    done.entry = { ...done.entry, state: 'done', workingMode: undefined }
    expect(summarizeAgents([monitoringAgent(), done], '2 агента')).toBe(
      '2 агента: наблюдение: 1, готово: 1'
    )
  })
})
