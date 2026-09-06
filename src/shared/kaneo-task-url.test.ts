import { describe, expect, it } from 'vitest'
import { normalizeKaneoSiteUrl, parseKaneoTaskUrl } from './kaneo-task-url'
import { isWorkItemLookupText } from './new-workspace/work-item-lookup-text'
import { normalizeWorkspaceLinkedItem } from './workspace-linked-item'
import {
  buildWorkspaceSourceSelection,
  shouldPreserveWorkspaceSourceOnRepoChange
} from './new-workspace/workspace-source'

const path = '/dashboard/workspace/ws-1/project/proj_2/task/task-3'

describe('Kaneo task URLs', () => {
  it('recognizes cloud and self-hosted origins and removes incidental URL state', () => {
    for (const site of ['https://cloud.kaneo.app', 'https://tasks.example.com:8443']) {
      expect(parseKaneoTaskUrl(` ${site}${path}/?view=board#comment `)).toEqual({
        siteUrl: site,
        workspaceId: 'ws-1',
        projectId: 'proj_2',
        taskId: 'task-3',
        url: site + path
      })
      expect(isWorkItemLookupText(site + path)).toBe(true)
    }
  })

  it('resolves board task panels to the same canonical task as the full task page', () => {
    for (const site of ['https://cloud.kaneo.app', 'https://tasks.example.com:8443']) {
      for (const suffix of ['?taskId=task-3', '/?filter=mine&taskId=task%2D3#comment']) {
        const boardUrl = `${site}/dashboard/workspace/ws-1/project/proj_2/board${suffix}`
        expect(parseKaneoTaskUrl(boardUrl)).toEqual(parseKaneoTaskUrl(site + path))
        expect(isWorkItemLookupText(boardUrl)).toBe(true)
      }
    }
  })

  it.each([
    '',
    '?taskId=',
    '?taskId=one&taskId=two',
    '?taskId=one&taskId=one',
    '?taskId=..',
    '?taskId=a%2Fb',
    '?taskId=a%5Cb',
    '?taskId=%20task-3',
    '?taskId=task-3%0A'
  ])('rejects a board URL without one valid task identifier: %s', (suffix) => {
    expect(
      parseKaneoTaskUrl(
        `https://tasks.example.com/dashboard/workspace/ws/project/proj/board${suffix}`
      )
    ).toBeNull()
  })

  it.each([
    'task-3',
    'https://example.com/dashboard/workspace/ws/project/proj',
    `http://example.com${path}`,
    `ftp://example.com${path}`,
    `https://user:secret@example.com${path}`,
    `https://example.com${path}/extra`,
    'https://example.com/dashboard/workspace/a/project/b/task/%2e%2e',
    'https://example.com/dashboard/workspace/a/project/b/task/a%2fb',
    'https://example.com/dashboard/workspace/a/project/b/settings?taskId=task-3',
    'https://user:secret@example.com/dashboard/workspace/a/project/b/board?taskId=task-3',
    'http://example.com/dashboard/workspace/a/project/b/board?taskId=task-3',
    `https://example.com${path}?${'a'.repeat(2048)}`,
    'https://linear.app/acme/issue/ENG-123',
    'https://gitlab.com/a/b/-/issues/123'
  ])('rejects unsupported or unsafe input: %s', (input) => {
    expect(parseKaneoTaskUrl(input)).toBeNull()
  })

  it('normalizes the configured origin and rejects paths and credentials', () => {
    expect(normalizeKaneoSiteUrl(' https://TASKS.example.com/ ')).toBe('https://tasks.example.com')
    for (const site of [
      'http://example.com',
      'https://example.com/api',
      'https://user@example.com',
      'https://example.com?redirect=1'
    ]) {
      expect(() => normalizeKaneoSiteUrl(site)).toThrow()
    }
  })

  it('preserves a Kaneo link through metadata normalization and repo changes', () => {
    const item = {
      provider: 'kaneo' as const,
      type: 'issue' as const,
      number: 3,
      title: 'Fix booking',
      url: `https://example.com${path}`
    }
    expect(normalizeWorkspaceLinkedItem(JSON.parse(JSON.stringify(item)))).toEqual(item)
    expect(buildWorkspaceSourceSelection({ linkedWorkItem: item })).toEqual({
      kind: 'kaneo',
      label: '#3 Fix booking',
      url: item.url
    })
    expect(shouldPreserveWorkspaceSourceOnRepoChange(item)).toBe(true)
  })
})
