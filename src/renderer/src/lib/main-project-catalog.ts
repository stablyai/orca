import { z } from 'zod'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Project, ProjectHostSetup } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { ProjectGroupSchema } from '../../../shared/project-section-catalog-schema'
import { catalogRowWith } from '../../../shared/sidebar-list/paired-server-catalog'
import {
  CATALOG_RECORDS_DOMAIN,
  type CatalogRecordsOrder
} from '../../../shared/sidebar-list/catalog-records-feed-contract'
import { SidebarInputsReadResultSchema } from '../../../shared/sidebar-list/sidebar-inputs-feed-contract'
import type { SidebarProjectCatalogRecords } from '../../../shared/sidebar-list/sidebar-project-catalog'
import {
  MAX_REPO_ICON_IDS_PER_READ,
  repoIconFeedKey
} from '../../../shared/sidebar-list/repo-icon-data-urls-contract'
import {
  SidebarFeedReader,
  type SidebarFeedReaderRead,
  type SidebarFeedTransport
} from '../../../shared/sidebar-feed-client/sidebar-feed-reader'
import { readDesktopSidebarFeed, onDesktopSidebarFeedInstalled } from './desktop-sidebar-feed'

/** Main's project catalog as this window reads it: main's rows, the window holds no copy. */
export type MainProjectCatalog = SidebarProjectCatalogRecords

const EMPTY_CATALOG: MainProjectCatalog = {
  repos: [],
  projectGroups: [],
  projects: [],
  projectHostSetups: []
}

// A failed read (main still starting) retries on its own.
const RETRY_MS = 1_000

// The installer keeps an unchanged entity's raw object, so each row is parsed once and keeps its
// identity: one group rename re-creates that group, not every repo.
function rowParser<Row>(schema: z.ZodType<Row>): (raw: unknown) => Row | null {
  const parsedByRaw = new WeakMap<object, Row | null>()
  return (raw) => {
    const remembered = typeof raw === 'object' && raw !== null ? parsedByRaw.get(raw) : undefined
    if (remembered !== undefined) {
      return remembered
    }
    const parsed = schema.safeParse(raw)
    const row = parsed.success ? parsed.data : null
    if (typeof raw === 'object' && raw !== null) {
      parsedByRaw.set(raw, row)
    }
    return row
  }
}

const parsers = {
  repos: rowParser(catalogRowWith<Repo>('id', 'path', 'displayName')),
  projectGroups: rowParser<ProjectGroup>(ProjectGroupSchema),
  projects: rowParser(catalogRowWith<Project>('id')),
  projectHostSetups: rowParser(catalogRowWith<ProjectHostSetup>('id', 'projectId'))
}
const OrderSchema = z.object({
  repos: z.array(z.string()),
  projectGroups: z.array(z.string()),
  projects: z.array(z.string()),
  projectHostSetups: z.array(z.string())
}) satisfies z.ZodType<CatalogRecordsOrder>

// Main withholds an upload's data URL (repoIcon null); its image arrives by id.
const iconDataUrls = new Map<string, string | null>()
const iconsAsked = new Set<string>()
const withIconByRepo = new WeakMap<Repo, { dataUrl: string; repo: Repo }>()

function withIcon(repo: Repo): Repo {
  if (repo.repoIcon !== null) {
    return repo
  }
  const id = readDesktopSidebarFeed()?.domains.repoIcons.get(repoIconFeedKey(repo))
  const dataUrl = id ? iconDataUrls.get(id) : undefined
  if (!dataUrl) {
    return repo
  }
  const cached = withIconByRepo.get(repo)
  if (cached?.dataUrl === dataUrl) {
    return cached.repo
  }
  const joined: Repo = { ...repo, repoIcon: { type: 'image', source: 'upload', src: dataUrl } }
  withIconByRepo.set(repo, { dataUrl, repo: joined })
  return joined
}

const IconReplySchema = z.object({
  icons: z.array(z.object({ id: z.string(), dataUrl: z.string().nullable() }))
})

function readMissingIcons(): void {
  const ids = readDesktopSidebarFeed()?.domains.repoIcons.values() ?? []
  const wanted = [...new Set(ids)].filter((id) => !iconsAsked.has(id))
  for (let start = 0; start < wanted.length; start += MAX_REPO_ICON_IDS_PER_READ) {
    const batch = wanted.slice(start, start + MAX_REPO_ICON_IDS_PER_READ)
    batch.forEach((id) => iconsAsked.add(id))
    void window.api.runtime
      .call({ method: 'sidebarInputs.repoIcons', params: { ids: batch } })
      .then((response) => {
        const reply = response.ok ? IconReplySchema.safeParse(response.result) : null
        if (!reply?.success) {
          batch.forEach((id) => iconsAsked.delete(id))
          return
        }
        reply.data.icons.forEach(({ id, dataUrl }) => iconDataUrls.set(id, dataUrl))
        rebuild()
      })
      .catch(() => batch.forEach((id) => iconsAsked.delete(id)))
  }
}

let rawDomain: ReadonlyMap<string, unknown> | null = null
let catalog: MainProjectCatalog | null = null
let readId = 0
const listeners = new Set<() => void>()

function listOf<Row>(keys: readonly string[], parse: (raw: unknown) => Row | null): Row[] {
  return keys.flatMap((key) => parse(rawDomain?.get(key)) ?? [])
}

// Unchanged rows keep the list's identity, so a reader's memo survives another field's change.
function sameRowsOr<Row>(previous: Row[] | undefined, next: Row[]): Row[] {
  return previous?.length === next.length && previous.every((row, index) => row === next[index])
    ? previous
    : next
}

function rebuild(): void {
  const order = rawDomain ? OrderSchema.safeParse(rawDomain.get('order')) : null
  if (!order?.success) {
    return
  }
  catalog = {
    repos: sameRowsOr(catalog?.repos, listOf(order.data.repos, parsers.repos).map(withIcon)),
    projectGroups: sameRowsOr(
      catalog?.projectGroups,
      listOf(order.data.projectGroups, parsers.projectGroups)
    ),
    projects: sameRowsOr(catalog?.projects, listOf(order.data.projects, parsers.projects)),
    projectHostSetups: sameRowsOr(
      catalog?.projectHostSetups,
      listOf(order.data.projectHostSetups, parsers.projectHostSetups)
    )
  }
  listeners.forEach((listener) => listener())
}

function installed({ snapshot, settledBy }: SidebarFeedReaderRead): void {
  if (!snapshot || settledBy === null) {
    return
  }
  readId = settledBy
  const domain = snapshot.installed.domains.get(CATALOG_RECORDS_DOMAIN) ?? null
  if (domain !== rawDomain || catalog === null) {
    rawDomain = domain
    rebuild()
  } else {
    // Nothing changed, but a write's wait reads the install's read id.
    listeners.forEach((listener) => listener())
  }
  readMissingIcons()
}

const readCatalogFromMain: SidebarFeedTransport = async (params) => {
  const response = await window.api.runtime
    .call({ method: 'sidebarInputs.readCatalog', params })
    .catch(() => null)
  const reply = response?.ok ? SidebarInputsReadResultSchema.safeParse(response.result) : null
  return reply?.success ? { kind: 'answered', reply: reply.data } : { kind: 'failed' }
}

let reader: SidebarFeedReader | null = null

/** Follows main's catalog for the window's life, from the first caller. */
export function followMainProjectCatalog(): void {
  if (reader) {
    return
  }
  const started = new SidebarFeedReader(
    readCatalogFromMain,
    { retryDelayMs: () => RETRY_MS },
    installed
  )
  reader = started
  window.api.runtime.onSidebarCatalogChanged((notice) => started.changed(notice))
  // An uploaded icon's id arrives with the sidebar feed.
  onDesktopSidebarFeedInstalled(() => {
    if (catalog) {
      rebuild()
    }
    readMissingIcons()
  })
  started.refresh()
}

/** Main's catalog as last installed; empty before main's first answer. */
export function readMainProjectCatalog(): MainProjectCatalog {
  return catalog ?? EMPTY_CATALOG
}

/** True once main's catalog has been installed at least once. */
export function hasMainProjectCatalog(): boolean {
  return catalog !== null
}

/** Runs on every install (and icon join), after the catalog it reads has changed. */
export function onMainProjectCatalogChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function waitFor(done: () => boolean, timeoutMs: number): Promise<boolean> {
  if (done()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      detach()
      resolve(false)
    }, timeoutMs)
    const detach = onMainProjectCatalogChanged(() => {
      if (done()) {
        clearTimeout(timer)
        detach()
        resolve(true)
      }
    })
  })
}

// Main's first answer can wait on its startup; nothing in the catalog waits on git.
const FIRST_CATALOG_LIMIT_MS = 30_000
// A paired server's change reaches main's catalog only after main reads that server again.
export const CATALOG_WRITE_LIMIT_MS = 10_000

/** Resolves true once main's catalog is installed, false if main never answers in time. */
export function awaitMainProjectCatalog(): Promise<boolean> {
  followMainProjectCatalog()
  return waitFor(() => catalog !== null, FIRST_CATALOG_LIMIT_MS)
}

/**
 * After a catalog write main (or a paired server through main) answered: resolves true once main's
 * catalog shows `shows`, read after the write; false when it never does within the limit.
 */
export function awaitMainProjectCatalogShows(
  shows: (catalog: MainProjectCatalog) => boolean
): Promise<boolean> {
  followMainProjectCatalog()
  const after = reader ? reader.refresh() : 0
  return waitFor(
    () => catalog !== null && readId >= after && shows(catalog),
    CATALOG_WRITE_LIMIT_MS
  )
}
