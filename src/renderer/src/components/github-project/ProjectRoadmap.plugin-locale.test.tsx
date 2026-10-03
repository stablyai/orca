// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectRoadmap from './ProjectRoadmap'
import { i18n, setRendererPluginLanguagePacks } from '@/i18n/i18n'
import { DEFAULT_LOCALE } from '@/i18n/supported-languages'
import { pluginLanguageResourceId } from '../../../../shared/plugins/plugin-language-pack-artifact'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github/project-types'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div role="tooltip">{children}</div>
}))

// The exact pack from the field crash report (v1.4.219, Windows).
const PACK_ID = 'plugin:stablyai.orca-portuguese/pt-BR' as const
const PACK_RESOURCE = pluginLanguageResourceId(PACK_ID)

function roadmapTable(): GitHubProjectTable {
  const row: GitHubProjectRow = {
    id: 'one',
    itemType: 'ISSUE',
    content: {
      number: 7,
      title: 'Scheduled',
      body: null,
      url: 'https://github.com/o/r/issues/7',
      state: 'OPEN',
      stateReason: null,
      isDraft: null,
      repository: 'o/r',
      assignees: [],
      labels: [],
      parentIssue: null,
      issueType: null
    },
    fieldValuesByFieldId: {
      f_start: { kind: 'date', fieldId: 'f_start', date: '2026-09-01' },
      f_end: { kind: 'date', fieldId: 'f_end', date: '2026-10-15' }
    },
    updatedAt: '2026-08-31T00:00:00Z',
    position: 0
  }
  return {
    project: {
      id: 'PVT_1',
      owner: 'stablyai',
      ownerType: 'organization',
      number: 3,
      title: 'Orca',
      url: 'https://github.com/orgs/stablyai/projects/3'
    },
    selectedView: {
      id: 'PVTV_1',
      number: 2,
      name: 'Roadmap',
      layout: 'ROADMAP_LAYOUT',
      filter: '',
      fields: [
        { kind: 'field', id: 'f_title', name: 'Title', dataType: 'TITLE' },
        { kind: 'field', id: 'f_start', name: 'Start date', dataType: 'DATE' },
        { kind: 'field', id: 'f_end', name: 'Target date', dataType: 'DATE' }
      ],
      groupByFields: [],
      sortByFields: []
    },
    rows: [row],
    totalCount: 1,
    parentFieldDropped: false
  }
}

afterEach(async () => {
  cleanup()
  window.localStorage.clear()
  setRendererPluginLanguagePacks([])
  await i18n.changeLanguage(DEFAULT_LOCALE)
})

describe('ProjectRoadmap with a plugin language pack active', () => {
  it('formats ticks with the pack locale instead of the synthetic resource tag', async () => {
    setRendererPluginLanguagePacks([
      {
        id: PACK_ID,
        resourceLanguage: PACK_RESOURCE,
        pluginKey: 'stablyai.orca-portuguese',
        locale: 'pt-BR',
        // Non-empty so i18next resolves to the pack, as a shipped pack does.
        catalog: { common: { cancel: 'Cancelar' } }
      }
    ])
    await i18n.changeLanguage(PACK_RESOURCE)
    expect(i18n.resolvedLanguage).toBe(PACK_RESOURCE)

    render(<ProjectRoadmap table={roadmapTable()} fallback={<div>list</div>} />)

    const expectedMonth = new Intl.DateTimeFormat('pt-BR', {
      month: 'short',
      timeZone: 'UTC'
    }).format(new Date(Date.UTC(2026, 8, 1)))
    expect(screen.getAllByText(expectedMonth, { exact: false }).length).toBeGreaterThan(0)
  })
})
