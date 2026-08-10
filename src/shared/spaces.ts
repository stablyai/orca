import type { Repo, Space } from './types'

/** Stable id of the Space that always exists. Renameable, never deletable. */
export const DEFAULT_SPACE_ID = 'space:default'
export const DEFAULT_SPACE_FALLBACK_NAME = 'Default'
const UNTITLED_SPACE_FALLBACK_NAME = 'Untitled space'

const MAX_SPACE_NAME_LENGTH = 60

export type SpaceCreateInput = { name: string; emoji?: string | null }
export type SpaceUpdates = Partial<Pick<Space, 'name' | 'emoji'>>

export function resolveSpaceId(spaceId: string | null | undefined): string {
  return typeof spaceId === 'string' && spaceId.length > 0 ? spaceId : DEFAULT_SPACE_ID
}

export function isDefaultSpaceId(spaceId: string | null | undefined): boolean {
  return resolveSpaceId(spaceId) === DEFAULT_SPACE_ID
}

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

function toGraphemes(value: string): string[] {
  return Array.from(graphemeSegmenter.segment(value), (entry) => entry.segment)
}

export function normalizeSpaceName(name: unknown, fallback = UNTITLED_SPACE_FALLBACK_NAME): string {
  if (typeof name !== 'string') {
    return fallback
  }
  const capped = limitSpaceName(name.trim()).trim()
  return capped.length > 0 ? capped : fallback
}

/** Caps by grapheme so a ZWJ/emoji sequence is never split into a lone surrogate. */
export function limitSpaceName(name: string): string {
  return name.length <= MAX_SPACE_NAME_LENGTH
    ? name
    : toGraphemes(name).slice(0, MAX_SPACE_NAME_LENGTH).join('')
}

/** Why: an all-format grapheme (ZWSP/ZWJ) from malformed persisted or remote data renders as an invisible badge. */
const INVISIBLE_GRAPHEME = /^[\s\p{Cf}]+$/u

export function normalizeSpaceEmoji(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const emoji = toGraphemes(value.trim())[0]
  return emoji && !INVISIBLE_GRAPHEME.test(emoji) ? emoji : null
}

export function createSpace(input: SpaceCreateInput & { now?: number }): Space {
  const now = input.now ?? Date.now()
  return {
    id: `space:${crypto.randomUUID()}`,
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
