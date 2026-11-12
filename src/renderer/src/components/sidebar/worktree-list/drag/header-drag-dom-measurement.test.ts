// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { measureProjectHeaderDragRects } from './project-header-drop'
import { measureProjectGroupHeaderDragRects } from './project-group-header-drop'
import { computeCombinedProjectHeaderDropTarget } from './project-header-group-drop'
import { measureSidebarVirtualContentBottom } from './header-drag-dom-measurement'
import {
  getHeaderSectionEndIndexByRowIndex,
  getProjectGroupHeaderSectionEndIndexByGroupId,
  getRepoHeaderSectionEndIndexByRepoId
} from '../viewport/worktree-header-section-boundaries'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { RenderRow } from '../listing/render-row'

function appendVirtualRow(
  container: HTMLElement,
  args: {
    index: number
    start: number
    height: number
    inner?: (rowEl: HTMLDivElement) => void
  }
): HTMLDivElement {
  const rowEl = document.createElement('div')
  rowEl.setAttribute('data-worktree-virtual-row', '')
  rowEl.setAttribute('data-index', String(args.index))
  rowEl.setAttribute('data-worktree-virtual-row-start', String(args.start))
  vi.spyOn(rowEl, 'getBoundingClientRect').mockReturnValue(
    new DOMRect(0, args.start, 240, args.height)
  )
  args.inner?.(rowEl)
  container.appendChild(rowEl)
  return rowEl
}

describe('header drag DOM measurement against compact measured virtual rows', () => {
  it('places the ungrouped drop indicator snugly below the last measured card instead of the inflated static estimate', () => {
    const container = document.createElement('div')
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 240, 800))
    Object.defineProperty(container, 'scrollHeight', { value: 800, configurable: true })

    const virtualList = document.createElement('div')
    virtualList.setAttribute('data-worktree-virtual-list', '')
    virtualList.style.height = '258px'
    vi.spyOn(virtualList, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 240, 258))
    container.appendChild(virtualList)

    // Row 0: root group (0..28), section ends at index 4 (estimated 208, real row 3 ends at 164)
    appendVirtualRow(virtualList, {
      index: 0,
      start: 0,
      height: 28,
      inner: (rowEl) => {
        const header = document.createElement('div')
        header.setAttribute('data-project-group-header-id', 'g-root')
        header.setAttribute('data-project-group-header-index', '0')
        header.setAttribute('data-project-group-header-bucket', 'root')
        header.setAttribute('data-project-group-header-section-end', '208')
        header.setAttribute('data-project-group-header-section-end-index', '4')
        vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 240, 28))
        rowEl.appendChild(header)
      }
    })

    // Row 1: subgroup (34..62), section ends at index 4 (estimated 208, real row 3 ends at 164)
    appendVirtualRow(virtualList, {
      index: 1,
      start: 34,
      height: 28,
      inner: (rowEl) => {
        const header = document.createElement('div')
        header.setAttribute('data-project-group-header-id', 'g-sub')
        header.setAttribute('data-project-group-header-index', '0')
        header.setAttribute('data-project-group-header-bucket', 'parent:g-root')
        header.setAttribute('data-project-group-header-section-end', '208')
        header.setAttribute('data-project-group-header-section-end-index', '4')
        vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 34, 240, 28))
        rowEl.appendChild(header)
      }
    })

    // Row 2: Unity project header (72..100), section ends at index 4
    appendVirtualRow(virtualList, {
      index: 2,
      start: 72,
      height: 28,
      inner: (rowEl) => {
        const header = document.createElement('div')
        header.setAttribute('data-repo-header-id', 'unity')
        header.setAttribute('data-repo-header-index', '0')
        header.setAttribute('data-repo-header-bucket', 'group:g-sub')
        header.setAttribute('data-repo-header-section-end', '208')
        header.setAttribute('data-repo-header-section-end-index', '4')
        vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 72, 240, 28))
        rowEl.appendChild(header)
      }
    })

    // Row 3: Unity compact card (110..164, real height 54px vs 116px estimate)
    appendVirtualRow(virtualList, { index: 3, start: 110, height: 54 })

    // Row 4: ungrouped "~" header (170..198), section ends at index 6 (estimated 356, real row 5 ends at 258)
    appendVirtualRow(virtualList, {
      index: 4,
      start: 170,
      height: 28,
      inner: (rowEl) => {
        const header = document.createElement('div')
        header.setAttribute('data-repo-header-id', 'home')
        header.setAttribute('data-repo-header-index', '0')
        header.setAttribute('data-repo-header-bucket', 'ungrouped')
        header.setAttribute('data-repo-header-section-end', '356')
        header.setAttribute('data-repo-header-section-end-index', '6')
        vi.spyOn(header, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 170, 240, 28))
        rowEl.appendChild(header)
      }
    })

    // Row 5: "~ / kkorn" compact card (204..258, real height 54px vs 116px estimate)
    appendVirtualRow(virtualList, { index: 5, start: 204, height: 54 })

    const groupHeaderRects = measureProjectGroupHeaderDragRects(container)
    const repoHeaderRects = measureProjectHeaderDragRects(container)
    const contentBottom = measureSidebarVirtualContentBottom(container)

    expect(contentBottom).toBe(258)
    expect(groupHeaderRects.find((r) => r.groupId === 'g-root')?.sectionBottom).toBe(164)
    expect(repoHeaderRects.find((r) => r.repoId === 'home')?.sectionBottom).toBe(258)

    // Hovering over the lower half of "~ / kkorn" (y = 240) previews insertion right below 258 (at 262), NOT 360!
    const target = computeCombinedProjectHeaderDropTarget({
      pointerY: 240,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g-sub',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-root', 'g-sub']),
      groupHeaderRects,
      repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g-sub', ['unity']],
        ['ungrouped', ['home']]
      ]),
      contentBottom
    })

    expect(target).toEqual({
      kind: 'slot',
      targetBucketKey: 'ungrouped',
      dropIndex: 1,
      dropIndicatorY: 262
    })

    // Hovering far down in empty space (y = 350) is rejected rather than snapping to a phantom 360px line.
    const farBelow = computeCombinedProjectHeaderDropTarget({
      pointerY: 350,
      containerTop: 0,
      scrollTop: 0,
      currentGroupId: 'g-sub',
      allowSlotReorder: true,
      joinableGroupIds: new Set(['g-root', 'g-sub']),
      groupHeaderRects,
      repoHeaderRects,
      sidebarRepoHeaderIdsByBucket: new Map([
        ['group:g-sub', ['unity']],
        ['ungrouped', ['home']]
      ]),
      contentBottom
    })
    expect(farBelow).toBeNull()
  })

  it('computes exclusive render-row end indices for nested groups and trailing ungrouped sections', () => {
    const groupRoot: ProjectGroup = {
      id: 'g-root',
      name: 'Root',
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const groupSub: ProjectGroup = {
      ...groupRoot,
      id: 'g-sub',
      name: 'Sub',
      parentGroupId: 'g-root'
    }
    const rows: RenderRow[] = [
      {
        type: 'header',
        key: 'project-group:g-root',
        label: 'Root',
        count: 1,
        icon: { kind: 'project' },
        projectGroup: groupRoot,
        projectGroupDepth: 0
      },
      {
        type: 'header',
        key: 'project-group:g-sub',
        label: 'Sub',
        count: 1,
        icon: { kind: 'project' },
        projectGroup: groupSub,
        projectGroupDepth: 1
      },
      {
        type: 'header',
        key: 'repo:unity',
        label: 'Unity',
        count: 1,
        icon: { kind: 'project' },
        repo: {
          id: 'unity',
          path: '/unity',
          displayName: 'Unity',
          badgeColor: '#000',
          addedAt: 1,
          projectGroupId: 'g-sub'
        },
        projectGroupDepth: 2
      },
      {
        type: 'header',
        key: 'repo:home',
        label: '~',
        count: 1,
        icon: { kind: 'project' },
        repo: {
          id: 'home',
          path: '/home',
          displayName: '~',
          badgeColor: '#000',
          addedAt: 1,
          projectGroupId: null
        },
        projectGroupDepth: 0
      }
    ]

    const groupEndIndexes = getProjectGroupHeaderSectionEndIndexByGroupId({ rows })
    const repoEndIndexes = getRepoHeaderSectionEndIndexByRepoId({ rows })

    expect(groupEndIndexes.get('g-root')).toBe(3)
    expect(groupEndIndexes.get('g-sub')).toBe(3)
    expect(repoEndIndexes.get('unity')).toBe(3)
    expect(repoEndIndexes.get('home')).toBe(4)
  })

  it('scopes section-end indices to each header row occurrence when local and remote hosts share group or repo IDs', () => {
    const sharedGroup: ProjectGroup = {
      id: 'shared-group',
      name: 'Shared',
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const sharedRepo = {
      id: 'shared-repo',
      path: '/shared',
      displayName: 'Shared Repo',
      badgeColor: '#000',
      addedAt: 1
    }
    const rows: RenderRow[] = [
      {
        type: 'host-header',
        key: 'host:local',
        hostId: 'local',
        kind: 'local',
        label: 'Local',
        detail: '',
        health: 'local',
        collapsed: false,
        count: 2
      },
      {
        type: 'header',
        key: 'host:local|project-group:shared-group',
        hostId: 'local',
        label: 'Shared',
        count: 1,
        icon: { kind: 'project' },
        projectGroup: { ...sharedGroup, executionHostId: 'local' },
        projectGroupDepth: 0
      },
      {
        type: 'header',
        key: 'host:local|repo:shared-repo',
        hostId: 'local',
        label: 'Shared Repo',
        count: 1,
        icon: { kind: 'project' },
        repo: { ...sharedRepo, projectGroupId: 'shared-group', executionHostId: 'local' },
        projectGroupDepth: 1
      },
      {
        type: 'host-header',
        key: 'host:runtime:env-1',
        hostId: 'runtime:env-1',
        kind: 'runtime',
        label: 'Remote',
        detail: '',
        health: 'available',
        collapsed: false,
        count: 2
      },
      {
        type: 'header',
        key: 'host:runtime:env-1|project-group:shared-group',
        hostId: 'runtime:env-1',
        label: 'Shared',
        count: 1,
        icon: { kind: 'project' },
        projectGroup: { ...sharedGroup, executionHostId: 'runtime:env-1' },
        projectGroupDepth: 0,
        repeated: true
      },
      {
        type: 'header',
        key: 'host:runtime:env-1|repo:shared-repo',
        hostId: 'runtime:env-1',
        label: 'Shared Repo',
        count: 1,
        icon: { kind: 'project' },
        repo: { ...sharedRepo, executionHostId: 'runtime:env-1' },
        anchorRepo: { ...sharedRepo, executionHostId: 'local' },
        projectGroupDepth: 0,
        repeated: true
      }
    ]

    const endByRowIndex = getHeaderSectionEndIndexByRowIndex({ rows })

    expect(endByRowIndex.get(1)).toBe(3)
    expect(endByRowIndex.get(2)).toBe(3)
    expect(endByRowIndex.get(4)).toBe(5)
    expect(endByRowIndex.get(5)).toBe(6)
  })
})
