import { describe, expect, it } from 'vitest'
import type { VirtualItem } from '@tanstack/react-virtual'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { RenderRow } from '../listing/render-row'
import {
  buildProjectGroupColorBands,
  buildRowProjectGroupColors
} from './project-group-color-bands'

const group = (id: string, color: string | null, parentGroupId: string | null = null) =>
  ({ id, name: id, color, parentGroupId }) as ProjectGroup
const repo = (id: string, projectGroupId: string | null) => ({ id, projectGroupId }) as Repo
const groupHeader = (g: ProjectGroup) =>
  ({
    type: 'header',
    key: `project-group:${g.id}`,
    count: 1,
    icon: { kind: 'project' },
    projectGroup: g
  }) as RenderRow
const repoHeader = (r: Repo) =>
  ({
    type: 'header',
    key: `repo:${r.id}`,
    count: 1,
    icon: { kind: 'project' },
    repo: r
  }) as RenderRow
const item = (r: Repo) => ({ type: 'item', repo: r }) as unknown as RenderRow
const pinnedHeader = {
  type: 'header',
  key: 'pinned',
  count: 1,
  icon: { kind: 'pinned' }
} as RenderRow

describe('buildRowProjectGroupColors', () => {
  const work = group('work', '#8b5cf6')
  const nested = group('nested', null, 'work')
  const plain = group('plain', null)
  const api = repo('api', 'work')
  const deep = repo('deep', 'nested')
  const loose = repo('loose', 'plain')

  it('colors a group header and every row inside it, inheriting through nested groups', () => {
    const colors = buildRowProjectGroupColors(
      [
        groupHeader(work),
        repoHeader(api),
        item(api),
        groupHeader(nested),
        repoHeader(deep),
        item(deep)
      ],
      [work, nested]
    )
    expect(colors).toEqual(Array(6).fill('#8b5cf6'))
  })

  it('leaves uncolored groups and pinned rows untinted', () => {
    const colors = buildRowProjectGroupColors(
      [pinnedHeader, item(api), groupHeader(plain), repoHeader(loose), item(loose)],
      [work, plain]
    )
    expect(colors).toEqual([null, null, null, null, null])
  })
})

describe('buildProjectGroupColorBands', () => {
  const v = (index: number, start: number, end: number) => ({ index, start, end }) as VirtualItem

  it('merges consecutive rows of one color and spans the gaps between them', () => {
    const bands = buildProjectGroupColorBands(
      ['#a', '#a', null, '#b'],
      [v(0, 0, 28), v(1, 34, 150), v(2, 156, 200), v(3, 206, 240)]
    )
    expect(bands).toEqual([
      { key: 'band:0', color: '#a', top: 0, height: 150 },
      { key: 'band:3', color: '#b', top: 206, height: 34 }
    ])
  })

  it('splits bands at non-adjacent rendered indexes', () => {
    const bands = buildProjectGroupColorBands(['#a', '#a', '#a'], [v(0, 0, 10), v(2, 20, 30)])
    expect(bands.map((band) => band.key)).toEqual(['band:0', 'band:2'])
  })
})
