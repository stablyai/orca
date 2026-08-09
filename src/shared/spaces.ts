import { normalizeExecutionHostId, type ExecutionHostId } from './execution-host'
import type { Repo, Space, SpaceWorkspaceSelectionKey, WorkspaceKey } from './types'

/** Stable id of the Space that always exists. Renameable, never deletable. */
export const DEFAULT_SPACE_ID = 'space:default'
export const DEFAULT_SPACE_FALLBACK_NAME = 'Default'
export const UNTITLED_SPACE_FALLBACK_NAME = 'Untitled space'

export const MAX_SPACE_NAME_LENGTH = 60

export type SpaceCreateInput = { name: string; emoji?: string | null }
export type SpaceUpdates = Partial<Pick<Space, 'name' | 'emoji'>>

function createSpaceId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID) {
    return randomUUID.call(globalThis.crypto)
  }
  return `space-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function resolveSpaceId(spaceId: string | null | undefined): string {
  return typeof spaceId === 'string' && spaceId.length > 0 ? spaceId : DEFAULT_SPACE_ID
}

export function isDefaultSpaceId(spaceId: string | null | undefined): boolean {
  return resolveSpaceId(spaceId) === DEFAULT_SPACE_ID
}

type GraphemeSegmenter = { segment: (input: string) => Iterable<{ segment: string }> }

let cachedGraphemeSegmenter: GraphemeSegmenter | null | undefined

function toGraphemes(value: string): string[] {
  if (cachedGraphemeSegmenter === undefined) {
    const ctor = (
      Intl as {
        Segmenter?: new (locale: string, options: { granularity: 'grapheme' }) => GraphemeSegmenter
      }
    ).Segmenter
    cachedGraphemeSegmenter = ctor ? new ctor('en', { granularity: 'grapheme' }) : null
  }
  // Why: ZWJ sequences split under the fallback, but Segmenter ships on every runtime we target.
  return cachedGraphemeSegmenter
    ? Array.from(cachedGraphemeSegmenter.segment(value), (entry) => entry.segment)
    : Array.from(value)
}

export function normalizeSpaceName(name: unknown, fallback = UNTITLED_SPACE_FALLBACK_NAME): string {
  if (typeof name !== 'string') {
    return fallback
  }
  const trimmed = name.trim()
  const capped = limitSpaceName(trimmed).trim()
  return capped.length > 0 ? capped : fallback
}

export function limitSpaceName(name: string): string {
  return name.length <= MAX_SPACE_NAME_LENGTH
    ? name
    : toGraphemes(name).slice(0, MAX_SPACE_NAME_LENGTH).join('')
}

export function normalizeSpaceEmoji(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  // ZWJ and tag characters are part of valid compound emoji.
  const cleaned = value
    .trim()
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) =>
      char === '\u200D' || /[\u{E0020}-\u{E007F}]/u.test(char) ? char : ''
    )
  return toGraphemes(cleaned)[0] || null
}

export function createSpace(input: SpaceCreateInput & { now?: number }): Space {
  const now = input.now ?? Date.now()
  return {
    id: createSpaceId(),
    name: normalizeSpaceName(input.name),
    emoji: normalizeSpaceEmoji(input.emoji),
    createdAt: now,
    updatedAt: now
  }
}

export function createDefaultSpace(now = Date.now()): Space {
  return {
    id: DEFAULT_SPACE_ID,
    name: DEFAULT_SPACE_FALLBACK_NAME,
    emoji: null,
    createdAt: now,
    updatedAt: now
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function normalizeSpaces(value: unknown): Space[] {
  const spaces: Space[] = []
  const seen = new Set<string>()
  const now = Date.now()
  for (const candidate of Array.isArray(value) ? value : []) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const raw = candidate as Partial<Space>
    if (typeof raw.id !== 'string' || raw.id.length === 0 || seen.has(raw.id)) {
      continue
    }
    seen.add(raw.id)
    const createdAt = finiteOr(raw.createdAt, now)
    spaces.push({
      id: raw.id,
      name: normalizeSpaceName(
        raw.name,
        raw.id === DEFAULT_SPACE_ID ? DEFAULT_SPACE_FALLBACK_NAME : UNTITLED_SPACE_FALLBACK_NAME
      ),
      emoji: normalizeSpaceEmoji(raw.emoji),
      createdAt,
      updatedAt: finiteOr(raw.updatedAt, createdAt)
    })
  }
  if (!seen.has(DEFAULT_SPACE_ID)) {
    spaces.push(createDefaultSpace(now))
  }
  return spaces.sort((left, right) =>
    left.id === DEFAULT_SPACE_ID || right.id === DEFAULT_SPACE_ID
      ? Number(right.id === DEFAULT_SPACE_ID) - Number(left.id === DEFAULT_SPACE_ID)
      : left.createdAt - right.createdAt || left.name.localeCompare(right.name)
  )
}

export function getSpaceById(
  spaces: readonly Space[],
  spaceId: string | null | undefined
): Space | undefined {
  const resolved = resolveSpaceId(spaceId)
  return spaces.find((space) => space.id === resolved)
}

export function hasCustomSpaces(spaces: readonly Space[]): boolean {
  return spaces.some((space) => space.id !== DEFAULT_SPACE_ID)
}

export function isRepoInSpace(
  repo: Pick<Repo, 'spaceId'>,
  spaceId: string | null | undefined
): boolean {
  return resolveSpaceId(repo.spaceId) === resolveSpaceId(spaceId)
}

export function clearRepoSpaceMembership<T extends Repo>(repo: T): T {
  if (repo.spaceId === undefined) {
    return repo
  }
  const next = { ...repo }
  delete next.spaceId
  return next
}

/** A repo pointing at a deleted Space would show in no Space at all; send it back to Default. */
export function clearMissingSpaceMemberships(repos: Repo[], spaces: readonly Space[]): Repo[] {
  const spaceIds = new Set(spaces.map((space) => space.id))
  return repos.map((repo) =>
    repo.spaceId && !spaceIds.has(repo.spaceId) ? clearRepoSpaceMembership(repo) : repo
  )
}

export function normalizeActiveSpaceId(value: unknown, spaces: readonly Space[]): string {
  return typeof value === 'string' && spaces.some((space) => space.id === value)
    ? value
    : DEFAULT_SPACE_ID
}

function isWorkspaceKey(value: unknown): value is WorkspaceKey {
  return typeof value === 'string' && (value.startsWith('worktree:') || value.startsWith('folder:'))
}

export function createSpaceWorkspaceSelectionKey(
  workspaceKey: WorkspaceKey,
  hostId?: ExecutionHostId | null
): SpaceWorkspaceSelectionKey {
  return hostId ? `${hostId}\0${workspaceKey}` : workspaceKey
}

export function parseSpaceWorkspaceSelectionKey(
  value: unknown
): { workspaceKey: WorkspaceKey; hostId?: ExecutionHostId } | null {
  if (isWorkspaceKey(value)) {
    return { workspaceKey: value }
  }
  if (typeof value !== 'string') {
    return null
  }
  const separator = value.indexOf('\0')
  const hostId = normalizeExecutionHostId(value.slice(0, separator))
  const workspaceKey = value.slice(separator + 1)
  return separator > 0 && hostId && isWorkspaceKey(workspaceKey) ? { workspaceKey, hostId } : null
}

export function normalizeLastWorkspaceKeyBySpaceId(
  value: unknown,
  spaces: readonly Space[]
): Record<string, SpaceWorkspaceSelectionKey> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const spaceIds = new Set(spaces.map((space) => space.id))
  const entries: Record<string, SpaceWorkspaceSelectionKey> = {}
  for (const [spaceId, rawSelection] of Object.entries(value as Record<string, unknown>)) {
    const selection = parseSpaceWorkspaceSelectionKey(rawSelection)
    if (spaceIds.has(spaceId) && selection) {
      entries[spaceId] = createSpaceWorkspaceSelectionKey(selection.workspaceKey, selection.hostId)
    }
  }
  return entries
}
