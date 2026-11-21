import { describe, expect, it } from 'vitest'
import { buildProjectGroupingIndex } from './project-section-grouping'
import type { ProjectSectionRepo } from './project-section-grouping'
import {
  buildProjectFilterEntries,
  isProjectFilterEntrySelected,
  withoutProjectFilterEntry,
  withProjectFilterEntry
} from './project-filter-entries'

function repo(
  id: string,
  displayName: string,
  executionHostId: ProjectSectionRepo['executionHostId']
): ProjectSectionRepo {
  return { id, path: `/src/${displayName}`, displayName, executionHostId }
}

function setup(projectId: string, checkout: ProjectSectionRepo) {
  return {
    id: `setup-${checkout.id}`,
    projectId,
    hostId: checkout.executionHostId ?? 'local',
    repoId: checkout.id,
    path: checkout.path,
    displayName: checkout.displayName,
    setupMethod: 'imported-existing-folder' as const
  }
}

const webOnMac = repo('web-mac', 'acme-web', 'local')
const webOnServer = repo('web-server', 'acme-web', 'runtime:build-box')
const docsOnMac = repo('docs-mac', 'docs', 'local')
const docsOnServer = repo('docs-server', 'docs', 'runtime:build-box')
const scratch = repo('scratch-mac', 'scratch', 'local')

const projectIndex = buildProjectGroupingIndex({
  projects: [
    { id: 'github:acme/web', displayName: 'Acme Web' },
    { id: 'github:acme/docs', displayName: 'Acme Docs' }
  ],
  projectHostSetups: [
    setup('github:acme/web', webOnMac),
    setup('github:acme/web', webOnServer),
    setup('github:acme/docs', docsOnMac),
    setup('github:acme/docs', docsOnServer)
  ]
})

describe('buildProjectFilterEntries', () => {
  it('lists a project checked out on several hosts once, with every checkout', () => {
    const entries = buildProjectFilterEntries([webOnMac, scratch, webOnServer], projectIndex)
    expect(entries.map((entry) => [entry.label, entry.repoIds])).toEqual([
      ['Acme Web', ['web-mac', 'web-server']],
      ['scratch', ['scratch-mac']]
    ])
  })
})

describe('project filter selection', () => {
  const entries = buildProjectFilterEntries(
    [webOnMac, webOnServer, docsOnMac, docsOnServer, scratch],
    projectIndex
  )
  const [web, docs] = entries

  it('treats a filter saved for one checkout as selecting the project', () => {
    expect(isProjectFilterEntrySelected(web, ['web-server'])).toBe(true)
    expect(isProjectFilterEntrySelected(web, ['docs-mac'])).toBe(false)
  })

  it('selects every host checkout and completes projects saved for one checkout', () => {
    expect(withProjectFilterEntry(['docs-mac', 'gone-repo'], web, entries)).toEqual([
      'docs-mac',
      'gone-repo',
      'web-mac',
      'web-server',
      'docs-server'
    ])
  })

  it('clears every host checkout of the removed project only', () => {
    expect(
      withoutProjectFilterEntry(['web-mac', 'web-server', 'docs-server'], web, entries)
    ).toEqual(['docs-server', 'docs-mac'])
    expect(withoutProjectFilterEntry(['docs-mac', 'docs-server'], docs, entries)).toEqual([])
  })
})
