import type { HostProcess, WorkspaceCopyHost } from './workspace-copy-host'
import { normalizePath, samePath } from './workspace-copy-source'
import type { WorkspaceCopyHolder, WorkspaceCopyHolderConsent } from './workspace-copy-types'
import { escapeRegex } from '../../string-utils'

const PROJECT_PATH_ARG = /-projectpath\s+(?:"([^"]+)"|(\S+))/i

async function processes(host: WorkspaceCopyHost): Promise<HostProcess[]> {
  try {
    return (await host.listProcesses?.()) ?? []
  } catch {
    // Why: the process table only adds warnings and names; never block a copy on it.
    return []
  }
}

/** Unity projects among `projects` that a running editor has open. */
export async function unityProjectsOpenInEditor(
  host: WorkspaceCopyHost,
  projects: readonly string[]
): Promise<string[]> {
  const open = (await processes(host))
    .filter((p) => p.name.toLowerCase() === 'unity.exe')
    .map((p) => PROJECT_PATH_ARG.exec(p.commandLine))
    .filter((match) => match !== null)
    .map((match) => normalizePath(match[1] ?? match[2]))
  return projects.filter((project) => open.some((path) => samePath(path, project)))
}

async function folderHolders(
  host: WorkspaceCopyHost,
  root: string
): Promise<ReadonlyMap<number, string>> {
  try {
    return (await host.listFolderHolders?.(root)) ?? new Map()
  } catch {
    return new Map()
  }
}

// Ending Explorer takes the taskbar and desktop with it; the user closes its window instead.
const NEVER_ENDED = new Set(['explorer.exe'])

/**
 * Programs holding `root`: a handle open in its folder (a shell or agent working there, an
 * Explorer window, a watcher) or a path inside it on the command line (editors, Unity).
 * Orca's own processes are left out unless `includeOrca`: removal closes the copy's terminals itself.
 */
export async function processesUnder(
  host: WorkspaceCopyHost,
  root: string,
  { includeOrca = false }: { includeOrca?: boolean } = {}
): Promise<WorkspaceCopyHolder[]> {
  const needle = normalizePath(root).toLowerCase().replaceAll('/', '\\')
  // Why the boundary: `D:\ws.wt\copy-1` must not match `D:\ws.wt\copy-10`.
  const mentions = new RegExp(`${escapeRegex(needle)}(?=$|[\\\\"'\\s])`)
  const [table, held] = await Promise.all([processes(host), folderHolders(host, root)])
  return table
    .filter(
      (p) =>
        p.pid !== process.pid &&
        (includeOrca || !p.ownedByOrca) &&
        (held.has(p.pid) || mentions.test(p.commandLine.toLowerCase().replaceAll('/', '\\')))
    )
    .map((p) => ({
      pid: p.pid,
      name: p.name,
      commandLine: p.commandLine,
      startedAt: p.startedAt ?? null,
      parentPid: p.parentPid ?? null,
      heldFolder: held.get(p.pid) ?? null,
      // An empty command line means the process refused a query handle, so it cannot be ended either.
      canEnd: p.commandLine !== '' && !NEVER_ENDED.has(p.name.toLowerCase())
    }))
}

export function processLabel(holder: Pick<WorkspaceCopyHolder, 'name' | 'pid'>): string {
  return `${holder.name} (pid ${holder.pid})`
}

export function isConsentedHolder(
  holder: WorkspaceCopyHolder,
  consents: readonly WorkspaceCopyHolderConsent[] | undefined
): boolean {
  return (consents ?? []).some(
    (consent) => consent.pid === holder.pid && consent.startedAt === holder.startedAt
  )
}

/** Ends the holders of `root` the user agreed to end; the host re-checks each is the same process. */
export async function endConsentedHolders(
  host: WorkspaceCopyHost,
  root: string,
  consents: readonly WorkspaceCopyHolderConsent[]
): Promise<void> {
  if (!host.endProcess) {
    return
  }
  for (const holder of await processesUnder(host, root)) {
    if (holder.canEnd !== false && isConsentedHolder(holder, consents)) {
      await host.endProcess(holder)
    }
  }
}
