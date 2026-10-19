import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import { i18n } from '@/i18n/i18n'
import { LinearIssueProjectLabel } from './linear-issue-project-label'

describe('LinearIssueProjectLabel', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders the project name and Linear color marker', () => {
    const html = renderToStaticMarkup(
      <LinearIssueProjectLabel project={{ id: 'project-1', name: 'Orca', color: '#5e6ad2' }} />
    )

    expect(html).toContain('Orca')
    expect(html).toContain('data-slot="linear-issue-project-marker"')
    expect(html).toContain('background-color:#5e6ad2')
  })

  it('uses the muted marker when Linear omits a project color', () => {
    const html = renderToStaticMarkup(
      <LinearIssueProjectLabel project={{ id: 'project-1', name: 'Orca' }} />
    )

    expect(html).toContain('data-slot="linear-issue-project-marker"')
    expect(html).toContain('bg-muted')
    expect(html).not.toContain('background-color:')
  })

  it('renders localized unassigned copy without a marker', async () => {
    await i18n.changeLanguage('ko')

    const html = renderToStaticMarkup(<LinearIssueProjectLabel />)

    expect(html).toContain('프로젝트 없음')
    expect(html).not.toContain('data-slot="linear-issue-project-marker"')
  })
})
