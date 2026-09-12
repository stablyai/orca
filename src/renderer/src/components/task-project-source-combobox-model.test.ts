import { describe, expect, it } from 'vitest'

import type { Repo } from '../../../shared/types'
import type { TaskProjectPickerGroup } from './task-page-default-repo-selection'
import { nextTaskProjectSelectionAfterToggle } from './task-project-source-combobox-model'

function repo(id: string, displayName = id): Repo {
  return {
    id,
    displayName,
    path: `/repos/${id}`,
    badgeColor: '#000'
  } as Repo
}

function group(projectKey: string, sources: Repo[]): TaskProjectPickerGroup {
  return {
    projectKey,
    repo: sources[0]!,
    sources
  }
}

describe('nextTaskProjectSelectionAfterToggle', () => {
  const a = repo('a')
  const b = repo('b')
  const c = repo('c')
  const groups = [group('a', [a]), group('b', [b]), group('c', [c])]

  it('from All projects, clicking a project selects only that project (#10182)', () => {
    const selected = new Set(['a', 'b', 'c'])
    const next = nextTaskProjectSelectionAfterToggle({
      groups,
      selected,
      group: groups[1]!
    })
    expect(next).toEqual(new Set(['b']))
  })

  it('adds an unselected project to a partial selection', () => {
    const selected = new Set(['a'])
    const next = nextTaskProjectSelectionAfterToggle({
      groups,
      selected,
      group: groups[1]!
    })
    expect(next).toEqual(new Set(['a', 'b']))
  })

  it('removes a selected project from a multi selection', () => {
    const selected = new Set(['a', 'b'])
    const next = nextTaskProjectSelectionAfterToggle({
      groups,
      selected,
      group: groups[0]!
    })
    expect(next).toEqual(new Set(['b']))
  })

  it('does not deselect the last remaining project', () => {
    const selected = new Set(['a'])
    const next = nextTaskProjectSelectionAfterToggle({
      groups,
      selected,
      group: groups[0]!
    })
    expect(next).toBeNull()
  })

  it('removes every host source of a multi-host project when deselecting', () => {
    const local = repo('proj-local', 'proj')
    const remote = repo('proj-ssh', 'proj')
    const multi = group('proj', [local, remote])
    // Three groups so deselecting multi is not the "all selected → only this" path.
    const groupsWithMulti = [multi, group('other', [b]), group('c', [c])]
    const selected = new Set(['proj-local', 'proj-ssh', 'b'])
    const next = nextTaskProjectSelectionAfterToggle({
      groups: groupsWithMulti,
      selected,
      group: multi
    })
    expect(next).toEqual(new Set(['b']))
  })

  it('from All projects with multi-host groups, click keeps the selected source', () => {
    const local = repo('proj-local', 'proj')
    const remote = repo('proj-ssh', 'proj')
    const multi = group('proj', [local, remote])
    const groupsWithMulti = [multi, group('other', [b])]
    const selected = new Set(['proj-local', 'b'])
    const next = nextTaskProjectSelectionAfterToggle({
      groups: groupsWithMulti,
      selected,
      group: multi
    })
    expect(next).toEqual(new Set(['proj-local']))
  })

  it('from All projects, narrowing preserves a non-primary selected host', () => {
    const local = repo('proj-local', 'proj')
    const remote = repo('proj-ssh', 'proj')
    // group.repo is sources[0] (local), but the user had the ssh host selected.
    const multi = group('proj', [local, remote])
    const groupsWithMulti = [multi, group('other', [b])]
    const selected = new Set(['proj-ssh', 'b'])
    const next = nextTaskProjectSelectionAfterToggle({
      groups: groupsWithMulti,
      selected,
      group: multi
    })
    expect(next).toEqual(new Set(['proj-ssh']))
  })
})
