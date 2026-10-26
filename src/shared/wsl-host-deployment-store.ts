import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeSecureJsonFileWithinLimit } from './bounded-secure-json-file'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { warnUnreadableEnvironmentState } from './runtime-environment-store-records'
import {
  getPreferredLoopbackRuntimePort,
  KnownRuntimeEnvironmentSchema,
  type KnownRuntimeEnvironment
} from './runtime-environments'
import { hardenExistingSecureFile } from './secure-file'
import { OrcadWslDeploymentLinkSchema } from './wsl-host-deployment-link'

// Isolate WSL records so older builds cannot reject the entire pairing store.
const WSL_HOST_DEPLOYMENTS_FILE = 'orca-wsl-host-deployments.json'
const MAX_WSL_HOST_DEPLOYMENTS_FILE_BYTES = 256 * 1024

/** A managed orcad in a WSL distro. The environment's name is its label; runtime state lives elsewhere. */
export const WslHostDeploymentRecordSchema = OrcadWslDeploymentLinkSchema.extend({
  environmentId: z.string().min(1),
  createdAt: z.number().finite()
})

export type WslHostDeploymentRecord = z.infer<typeof WslHostDeploymentRecordSchema>

// Records stay opaque so one bad or newer-kind record cannot hide the rest.
const EnvelopeSchema = z.object({
  version: z.literal(1),
  deployments: z.array(z.unknown())
})

type StoredRecord = {
  environmentId: string | undefined
  raw: unknown
  deployment: WslHostDeploymentRecord | undefined
}

export type WslHostDeployments = {
  deployments: WslHostDeploymentRecord[]
  /** Environment ids whose record this build cannot read; those environments must not be used. */
  unreadableEnvironmentIds: Set<string>
}

export class WslHostDeploymentStoreInvalidError extends Error {
  constructor(path: string, environmentId?: string) {
    super(
      environmentId === undefined
        ? `Could not read Orca WSL host deployments at ${path}; the file is invalid.`
        : `Could not read the Orca WSL host deployment for ${environmentId} at ${path}; it may need a newer version of Orca.`
    )
    this.name = 'WslHostDeploymentStoreInvalidError'
  }
}

export function getWslHostDeploymentStorePath(userDataPath: string): string {
  return join(userDataPath, WSL_HOST_DEPLOYMENTS_FILE)
}

function recordEnvironmentId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null || !('environmentId' in raw)) {
    return undefined
  }
  return typeof raw.environmentId === 'string' && raw.environmentId.length > 0
    ? raw.environmentId
    : undefined
}

function readStoredRecords(userDataPath: string): StoredRecord[] {
  const path = getWslHostDeploymentStorePath(userDataPath)
  if (!existsSync(path)) {
    return []
  }
  let raws: unknown[]
  try {
    hardenExistingSecureFile(path)
    raws = EnvelopeSchema.parse(
      JSON.parse(
        readNodeFileSyncWithinLimit(path, MAX_WSL_HOST_DEPLOYMENTS_FILE_BYTES).buffer.toString(
          'utf8'
        )
      )
    ).deployments
  } catch {
    throw new WslHostDeploymentStoreInvalidError(path)
  }
  const records = raws.map((raw): StoredRecord => {
    const parsed = WslHostDeploymentRecordSchema.safeParse(raw)
    return {
      environmentId: recordEnvironmentId(raw),
      raw,
      deployment: parsed.success ? parsed.data : undefined
    }
  })
  // Why: two records for one environment leave no single owner to trust.
  const seen = new Map<string, number>()
  for (const { environmentId } of records) {
    if (environmentId !== undefined) {
      seen.set(environmentId, (seen.get(environmentId) ?? 0) + 1)
    }
  }
  return records.map((record) =>
    record.environmentId !== undefined && (seen.get(record.environmentId) ?? 0) > 1
      ? { ...record, deployment: undefined }
      : record
  )
}

/** Throws WslHostDeploymentStoreInvalidError when the file itself is unreadable. */
export function readWslHostDeployments(userDataPath: string): WslHostDeployments {
  const result: WslHostDeployments = { deployments: [], unreadableEnvironmentIds: new Set() }
  for (const record of readStoredRecords(userDataPath)) {
    if (record.deployment) {
      result.deployments.push(record.deployment)
    } else if (record.environmentId !== undefined) {
      result.unreadableEnvironmentIds.add(record.environmentId)
    }
  }
  return result
}

/** Replace/remove one record while preserving every other record and unknown field verbatim in place. */
export function writeWslHostDeployment(
  userDataPath: string,
  environmentId: string,
  deployment: WslHostDeploymentRecord | null
): void {
  const path = getWslHostDeploymentStorePath(userDataPath)
  const next = deployment ? WslHostDeploymentRecordSchema.parse(deployment) : null
  if (next && next.environmentId !== environmentId) {
    throw new Error('A WSL host deployment must be written under its own environment id.')
  }
  const records = readStoredRecords(userDataPath)
  if (records.some((record) => record.environmentId === environmentId && !record.deployment)) {
    throw new WslHostDeploymentStoreInvalidError(path, environmentId)
  }
  const raws = records.flatMap((record) =>
    record.environmentId !== environmentId ? [record.raw] : next ? [next] : []
  )
  if (next && !records.some((record) => record.environmentId === environmentId)) {
    raws.push(next)
  }
  writeSecureJsonFileWithinLimit(
    path,
    { version: 1, deployments: raws },
    MAX_WSL_HOST_DEPLOYMENTS_FILE_BYTES,
    { durable: true }
  )
}

function hasNonWslOwner(environment: KnownRuntimeEnvironment): boolean {
  return Boolean(
    environment.orcadDeployment ||
    environment.sshAccess ||
    environment.pendingSshAccessOperation ||
    environment.connectionDependency
  )
}

/** Overlay WSL links and hide unreadable records’ environments. Ignore stale links that conflict with SSH state or pairing. */
export function overlayWslHostDeployments(
  environments: readonly KnownRuntimeEnvironment[],
  { deployments, unreadableEnvironmentIds }: WslHostDeployments
): KnownRuntimeEnvironment[] {
  const byEnvironmentId = new Map(deployments.map((record) => [record.environmentId, record]))
  // Only a loopback pairing with no SSH link can be a WSL host; an unreadable record hides no other.
  const hidden = environments.filter(
    (environment) =>
      unreadableEnvironmentIds.has(environment.id) &&
      !hasNonWslOwner(environment) &&
      getPreferredLoopbackRuntimePort(environment) !== null
  )
  const hiddenIds = new Set(hidden.map((environment) => environment.id))
  if (hidden.length > 0) {
    warnUnreadableEnvironmentState(
      `Hiding ${hidden.length} server(s) whose WSL deployment cannot be read (ids: ${hidden.map((environment) => environment.id).join(', ')}); they may need a newer version of Orca.`
    )
  }
  return environments
    .filter((environment) => !hiddenIds.has(environment.id))
    .map((environment) => {
      const record = byEnvironmentId.get(environment.id)
      if (!record) {
        return environment
      }
      const { environmentId: _environmentId, createdAt: _createdAt, ...link } = record
      const overlaid = hasNonWslOwner(environment)
        ? null
        : KnownRuntimeEnvironmentSchema.safeParse({ ...environment, orcadDeployment: link })
      if (!overlaid?.success) {
        warnUnreadableEnvironmentState(
          `Ignoring the WSL deployment for server ${environment.id}; it conflicts with the server's pairing or SSH link.`
        )
        return environment
      }
      return overlaid.data
    })
}
