import type { ClickUpList } from '../../../shared/clickup-types'

export type ClickUpSprint = {
  listId: string
  name: string
  folderId: string | null
  folderName?: string
  taskCount: number | null
  // ISO dates, from the List's own dates or parsed from "(10/6 - 10/19)".
  startDate: string | null
  dueDate: string | null
}

export type ClickUpSprintFolder = {
  // '' groups Sprint Lists that sit directly in the Space.
  id: string
  name: string | null
  sprints: ClickUpSprint[]
}

const SPRINT_NAME_COLLATOR = new Intl.Collator(undefined, { numeric: true })
const SPRINT_PATTERN = /\bsprints?\b/i
// "Sprint 12 (10/6 - 10/19)" — the Sprints ClickApp's default List name.
const NAME_RANGE_PATTERN = /\((\d{1,2})\/(\d{1,2})\s*[-–]\s*(\d{1,2})\/(\d{1,2})\)/

function rangeFromName(
  name: string,
  referenceYear: number
): { startDate: string; dueDate: string } | null {
  const match = NAME_RANGE_PATTERN.exec(name)
  if (!match) {
    return null
  }
  const [startMonth, startDay, endMonth, endDay] = match.slice(1).map(Number)
  // A December-to-January Sprint ends in the following year.
  const endYear = endMonth < startMonth ? referenceYear + 1 : referenceYear
  const start = new Date(referenceYear, startMonth - 1, startDay)
  const end = new Date(endYear, endMonth - 1, endDay, 23, 59, 59)
  return Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())
    ? null
    : { startDate: start.toISOString(), dueDate: end.toISOString() }
}

// Sprint Lists are named like "Sprint 12", or are dated Lists inside a Folder
// named like "Sprints" (where the Sprints ClickApp puts them). Undated Lists
// in a sprint Folder, such as "QE Backlog Tasks", stay ordinary Lists.
export function isClickUpSprintList(list: ClickUpList): boolean {
  if (SPRINT_PATTERN.test(list.name)) {
    return true
  }
  return (
    SPRINT_PATTERN.test(list.folder?.name ?? '') &&
    Boolean(list.startDate || list.dueDate || NAME_RANGE_PATTERN.test(list.name))
  )
}

function compareSprints(a: ClickUpSprint, b: ClickUpSprint): number {
  // Oldest first, as ClickUp's sidebar shows them; undated Sprints go last.
  if (a.startDate && b.startDate) {
    return a.startDate.localeCompare(b.startDate)
  }
  if (a.startDate || b.startDate) {
    return a.startDate ? -1 : 1
  }
  return SPRINT_NAME_COLLATOR.compare(a.name, b.name)
}

export function detectClickUpSprints(
  lists: readonly ClickUpList[],
  now: Date = new Date()
): ClickUpSprint[] {
  return lists
    .filter(isClickUpSprintList)
    .map((list) => {
      const parsed =
        list.startDate || list.dueDate ? null : rangeFromName(list.name, now.getFullYear())
      return {
        listId: list.id,
        name: list.name,
        folderId: list.folder?.id ?? null,
        folderName: list.folder?.name,
        taskCount: list.taskCount ?? null,
        startDate: list.startDate ?? parsed?.startDate ?? null,
        dueDate: list.dueDate ?? parsed?.dueDate ?? null
      }
    })
    .sort(compareSprints)
}

export function groupClickUpSprintFolders(
  sprints: readonly ClickUpSprint[]
): ClickUpSprintFolder[] {
  const folders = new Map<string, ClickUpSprintFolder>()
  for (const sprint of sprints) {
    const id = sprint.folderId ?? ''
    const folder = folders.get(id) ?? { id, name: sprint.folderName ?? null, sprints: [] }
    folder.sprints.push(sprint)
    folders.set(id, folder)
  }
  return [...folders.values()]
}

export function findCurrentClickUpSprint(
  sprints: readonly ClickUpSprint[],
  now: Date = new Date()
): ClickUpSprint | null {
  const time = now.getTime()
  return (
    sprints.find((sprint) => {
      if (!sprint.startDate || !sprint.dueDate) {
        return false
      }
      return Date.parse(sprint.startDate) <= time && time <= Date.parse(sprint.dueDate)
    }) ?? null
  )
}

function compareIdsNewestFirst(a: string, b: string): number {
  // ClickUp ids grow over time, so a longer or larger id is a newer Folder.
  return b.length - a.length || b.localeCompare(a)
}

// Why newest Folder rather than most tasks: teams leave older sprint Folders
// running (an old "Dev Sprints" Folder can hold the most tasks) while the
// one they work from is the latest, e.g. "Team Sprints - Q3 2026".
export function pickDefaultClickUpSprintFolder(
  folders: readonly ClickUpSprintFolder[],
  now: Date = new Date()
): ClickUpSprintFolder | null {
  const active = folders.filter((folder) => findCurrentClickUpSprint(folder.sprints, now))
  const candidates = active.length > 0 ? active : folders
  return [...candidates].sort((a, b) => compareIdsNewestFirst(a.id, b.id))[0] ?? null
}
