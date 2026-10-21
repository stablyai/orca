import type { AppState } from '@/store/types'
import { group, mainWt, repo, wt } from './sidebar-list-golden-factories.test-fixture'

// A group ahead of every other holding a git project and a folder project, a child group of it holding
// only a folder project, and an empty group: the phone must file each project under its group, in order.
const lake = repo('lake', 'Lake', { projectGroupId: 'pg-school', projectGroupOrder: 1 })
const capstone = repo('capstone', 'capstone', {
  kind: 'folder',
  projectGroupId: 'pg-school',
  projectGroupOrder: 0
})
const notes = repo('notes', 'notes', { kind: 'folder', projectGroupId: 'pg-folder-only' })
export const GROUPED_REPOS = [lake, capstone, notes]
export const GROUPED_WORKTREES: AppState['worktreesByRepo'] = {
  lake: [mainWt(lake), wt(lake, 'essay', { sortOrder: 5 })],
  capstone: [mainWt(capstone, { branch: '' })],
  notes: [mainWt(notes, { branch: '' })]
}
export const GROUPS_OF_GROUPED_REPOS = [
  group('pg-school', 'school', { tabOrder: -1, color: '#22c55e' }),
  group('pg-folder-only', 'Folder only', { tabOrder: 5, parentGroupId: 'pg-school' }),
  group('pg-empty', 'Empty group', { tabOrder: 6 })
]
