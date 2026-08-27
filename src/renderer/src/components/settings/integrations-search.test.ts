import { beforeEach, describe, expect, it } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { getIntegrationsPaneSearchEntries } from './integrations-search'

describe('integration settings search', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('lists Kanban once without changing the existing providers', () => {
    expect(getIntegrationsPaneSearchEntries().map((entry) => entry.title)).toEqual([
      'GitHub Integration',
      'GitLab Integration',
      'Bitbucket Integration',
      'Azure DevOps Integration',
      'Gitea Integration',
      'Jira Integration',
      'Linear Integration',
      'Kanban Integration'
    ])
  })

  it('finds the Kanban entry by its own keywords', () => {
    const kanban = getIntegrationsPaneSearchEntries().find(
      (entry) => entry.title === 'Kanban Integration'
    )
    expect(kanban?.keywords).toContain('kanban')
    expect(kanban?.keywords).toContain('personal token')
  })
})
