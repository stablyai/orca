// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'
import { normalizeNestedRepoScanResult } from '@/store/project-groups/nested-repository-operations'
import { NestedRepoScanExplanations } from './NestedRepoScanExplanations'

const scan: NestedRepoScanResult = {
  selectedPath: '/remote/platform',
  selectedPathKind: 'non_git_folder',
  repos: [],
  truncated: false,
  timedOut: false,
  stopped: false,
  durationMs: 1,
  maxDepth: 3,
  maxRepos: 100,
  timeoutMs: null
}
const render = (value: NestedRepoScanResult) =>
  renderToStaticMarkup(<NestedRepoScanExplanations scan={value} />)

describe('scan explanations', () => {
  it('accepts legacy responses without claiming verified zero exclusions', () => {
    const legacy = normalizeNestedRepoScanResult(JSON.parse(JSON.stringify(scan)))
    expect(legacy.diagnostics).toBeUndefined()
    expect(render(legacy)).not.toContain('Folders:')
    expect(render({ ...legacy, selectedPathKind: 'git_repo' })).toContain(
      'Nested repository scanning was skipped'
    )
  })

  it('renders host evidence as literal text with native keyboard disclosure', () => {
    const value = {
      ...scan,
      diagnostics: {
        counts: { gitignore: 2, unreadable: 1 },
        omittedDetails: 8,
        details: [
          {
            path: '/remote/<script>/api',
            reason: 'gitignore',
            ignoreFile: '/remote/platform/.gitignore',
            rule: '/api/',
            line: 3,
            shortened: true
          },
          { path: 'C:\\host\\locked', reason: 'unreadable', errorCode: 'EACCES' }
        ]
      }
    }
    const html = render(value)
    expect(html).toContain('Folders: 2. Excluded by .gitignore')
    expect(html).toContain('<summary')
    expect(html).toContain('Show scan details')
    expect(html).toContain('/remote/&lt;script&gt;/api')
    expect(html).toContain('/remote/platform/.gitignore:3')
    expect(html).toContain('/api/')
    expect(html).toContain('contents were not checked')
    expect(html).toContain('EACCES')
    expect(html).toContain('8 additional details omitted')
    expect(html).toContain('Long path or rule text was shortened')
    expect(html).not.toContain('repositories missing')
  })

  it('preserves unfamiliar host reasons and valid results', () => {
    const value = {
      ...scan,
      repos: [{ path: '/remote/api', displayName: 'api', depth: 1 }],
      diagnostics: {
        counts: { 'future-policy': 1 },
        details: [{ path: '/remote/other', reason: 'future-policy' }],
        omittedDetails: 0
      }
    }
    const normalized = normalizeNestedRepoScanResult(JSON.parse(JSON.stringify(value)))
    expect(normalized.repos).toEqual(value.repos)
    expect(normalized.diagnostics).toEqual(value.diagnostics)
    expect(render(normalized)).toContain('Exclusion details unavailable')
    expect(render(normalized)).not.toContain('future-policy')
  })

  it('distinguishes cancellation, timeout, repository cap, and depth', () => {
    const html = render({
      ...scan,
      stopped: true,
      timedOut: true,
      truncated: true,
      diagnostics: { counts: { 'depth-limit': 1 }, details: [], omittedDetails: 0 }
    })
    expect(html).toContain('Scan stopped by request')
    expect(html).toContain('time limit')
    expect(html).toContain('repository limit')
    expect(html).toContain('below scan depth were not checked')
  })
})
