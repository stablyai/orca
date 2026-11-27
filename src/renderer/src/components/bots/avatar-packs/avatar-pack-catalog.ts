import { useEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { avatarPackAssetUrl } from '../../../../../shared/avatar-pack-scheme'
import type {
  AvatarAnimationState,
  AvatarKeyframedAnimation,
  AvatarPackCatalogIndex
} from './avatar-pack-types'

const MAX_CACHED_ANIMATIONS = 128

let cachedCatalog: AvatarPackCatalogIndex | null = null
let catalogSettled = false
let catalogPromise: Promise<AvatarPackCatalogIndex | null> | null = null
let catalogVersion = 0
let snapshotRevision = 0
let trackedPacksDir: string | undefined

const animationCache = new Map<string, AvatarKeyframedAnimation>()
const listeners = new Set<() => void>()

function emitCatalogChange(): void {
  snapshotRevision += 1
  for (const listener of listeners) {
    listener()
  }
}

function subscribeCatalog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getCatalogSnapshot(): number {
  return snapshotRevision
}

export function invalidateAvatarPackCatalogCache(): void {
  cachedCatalog = null
  catalogSettled = false
  catalogPromise = null
  animationCache.clear()
  catalogVersion += 1
  emitCatalogChange()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isAvatarPackCatalogIndex(value: unknown): value is AvatarPackCatalogIndex {
  return isRecord(value)
}

function isAvatarKeyframedAnimation(value: unknown): value is AvatarKeyframedAnimation {
  return isRecord(value) && Array.isArray(value.nodes)
}

function settleCatalog(requestVersion: number, next: AvatarPackCatalogIndex | null): void {
  if (requestVersion === catalogVersion) {
    cachedCatalog = next
    catalogSettled = true
    emitCatalogChange()
  }
}

export async function fetchAvatarPackCatalog(): Promise<AvatarPackCatalogIndex | null> {
  if (catalogSettled) {
    return cachedCatalog
  }
  if (catalogPromise) {
    return catalogPromise
  }
  const requestVersion = catalogVersion
  const pending = (async (): Promise<AvatarPackCatalogIndex | null> => {
    try {
      const url = avatarPackAssetUrl('catalog_index.json')
      const resp = await fetch(url, { cache: 'no-store' })
      if (!resp.ok) {
        settleCatalog(requestVersion, null)
        return null
      }
      const raw: unknown = await resp.json()
      const parsed = isAvatarPackCatalogIndex(raw) ? raw : null
      settleCatalog(requestVersion, parsed)
      return parsed
    } catch {
      settleCatalog(requestVersion, null)
      return null
    } finally {
      if (requestVersion === catalogVersion) {
        catalogPromise = null
      }
    }
  })()
  catalogPromise = pending
  return pending
}

export function useAvatarPackCatalog(enabled = true): {
  catalog: AvatarPackCatalogIndex | null
  loading: boolean
  version: number
} {
  const customDir = useAppStore((s) => s.settings?.avatarPacksDir ?? '')
  const version = useSyncExternalStore(subscribeCatalog, getCatalogSnapshot, getCatalogSnapshot)

  useEffect(() => {
    if (trackedPacksDir === undefined) {
      trackedPacksDir = customDir
      return
    }
    if (trackedPacksDir !== customDir) {
      trackedPacksDir = customDir
      invalidateAvatarPackCatalogCache()
    }
  }, [customDir])

  useEffect(() => {
    if (!enabled || catalogSettled) {
      return
    }
    void fetchAvatarPackCatalog()
  }, [enabled, version])

  return {
    catalog: cachedCatalog,
    loading: enabled && !catalogSettled,
    version
  }
}

export function getAvatarPackIds(catalog: AvatarPackCatalogIndex): string[] {
  return Object.keys(catalog).filter((key) => {
    const chars = catalog[key]?.characters
    return Boolean(chars && Object.keys(chars).length > 0)
  })
}

export function formatAvatarPackId(packId: string): string {
  const spaced = packId
    .replace(/([a-z])(\d)/gi, '$1 $2')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
  if (!spaced) {
    return packId
  }
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
}

export function formatAvatarPackLabel(
  catalog: AvatarPackCatalogIndex | null,
  packId: string
): string {
  const manifestName = catalog?.[packId]?.manifest?.name?.trim()
  return manifestName || formatAvatarPackId(packId)
}

export function resolveAvatarPackId(
  catalog: AvatarPackCatalogIndex,
  requestedPack: string | undefined
): string | null {
  if (
    requestedPack &&
    catalog[requestedPack] &&
    getAvatarPackCharacters(catalog, requestedPack).length > 0
  ) {
    return requestedPack
  }
  return getAvatarPackIds(catalog)[0] ?? null
}

export function getAvatarPackCharacters(catalog: AvatarPackCatalogIndex, pack: string): string[] {
  const entry = catalog[pack]
  if (!entry?.characters) {
    return []
  }
  return Object.keys(entry.characters).sort((a, b) => {
    const na = Number(a)
    const nb = Number(b)
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      return na - nb
    }
    return a.localeCompare(b)
  })
}

export function resolveAvatarPackCharacterKey(
  catalog: AvatarPackCatalogIndex,
  pack: string,
  charIndex: number
): string | null {
  const entry = catalog[pack]
  if (!entry?.characters) {
    return null
  }
  const exactKey = String(charIndex)
  if (charIndex >= 0 && Object.hasOwn(entry.characters, exactKey)) {
    return exactKey
  }
  const keys = getAvatarPackCharacters(catalog, pack)
  if (keys.length === 0) {
    return null
  }
  const safeIdx =
    ((Math.trunc(Number.isFinite(charIndex) ? charIndex : 0) % keys.length) + keys.length) %
    keys.length
  return keys[safeIdx] ?? keys[0] ?? null
}

export function resolveAvatarPackCharacterIndex(
  catalog: AvatarPackCatalogIndex,
  pack: string,
  charIndex: number
): number {
  const key = resolveAvatarPackCharacterKey(catalog, pack, charIndex)
  if (key === null) {
    return 0
  }
  const parsed = Number.parseInt(key, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

export function resolveAvatarPackAnimationFile(
  catalog: AvatarPackCatalogIndex,
  pack: string,
  charIndex: number,
  state: AvatarAnimationState
): string | null {
  const entry = catalog[pack]
  if (!entry) {
    return null
  }
  const charKey = resolveAvatarPackCharacterKey(catalog, pack, charIndex)
  if (charKey === null) {
    return null
  }
  const charData = entry.characters[charKey]
  if (!charData) {
    return null
  }
  const variants = charData[state]
  if (variants && variants.length > 0) {
    return variants[0]?.file ?? null
  }
  const idleVariants = charData.idle
  if (idleVariants && idleVariants.length > 0) {
    return idleVariants[0]?.file ?? null
  }
  for (const list of Object.values(charData)) {
    if (list && list.length > 0 && list[0]?.file) {
      return list[0].file
    }
  }
  return null
}

export async function loadAvatarPackAnimation(
  pack: string,
  fileName: string
): Promise<AvatarKeyframedAnimation | null> {
  const key = `${catalogVersion}:${pack}:${fileName}`
  const hit = animationCache.get(key)
  if (hit) {
    return hit
  }
  try {
    const url = avatarPackAssetUrl(`packs/${pack}/animations_json/${fileName}`)
    const resp = await fetch(url)
    if (!resp.ok) {
      return null
    }
    const raw: unknown = await resp.json()
    if (!isAvatarKeyframedAnimation(raw)) {
      return null
    }
    animationCache.set(key, raw)
    if (animationCache.size > MAX_CACHED_ANIMATIONS) {
      const oldest = animationCache.keys().next()
      if (!oldest.done) {
        animationCache.delete(oldest.value)
      }
    }
    return raw
  } catch {
    return null
  }
}
