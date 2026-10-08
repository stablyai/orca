import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFileWithinLimit } from './bounded-secure-json-file'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import {
  PersistedRuntimeEnvironmentSchema,
  RuntimeEnvironmentStoreSchema,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentStore
} from './runtime-environments'
import {
  overlayRuntimeEnvironmentSidecar,
  readRuntimeEnvironmentSidecar,
  RuntimeEnvironmentSidecarInvalidError
} from './runtime-environment-sidecar'
import { hardenExistingSecureFile } from './secure-file'

const ENVIRONMENTS_FILE = 'orca-environments.json'
export const MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES = 1024 * 1024

export type RuntimeEnvironmentStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class RuntimeEnvironmentStoreError extends Error {
  readonly code: RuntimeEnvironmentStoreErrorCode

  constructor(code: RuntimeEnvironmentStoreErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeEnvironmentStoreError'
    this.code = code
  }
}

export function getEnvironmentStorePath(userDataPath: string): string {
  return join(userDataPath, ENVIRONMENTS_FILE)
}

/** The orca-environments.json content, exactly as shipped builds read and rewrite it. */
export function readPersistedEnvironmentStore(
  userDataPath: string,
  options: { requireStoreFile?: boolean } = {}
): RuntimeEnvironmentStore {
  const path = getEnvironmentStorePath(userDataPath)
  if (!options.requireStoreFile && !existsSync(path)) {
    return { version: 1, environments: [] }
  }
  try {
    hardenExistingSecureFile(path)
    const parsed = RuntimeEnvironmentStoreSchema.parse(
      JSON.parse(
        readNodeFileSyncWithinLimit(path, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES).buffer.toString(
          'utf8'
        )
      )
    )
    return {
      version: 1,
      environments: parsed.environments
        .map((entry) => PersistedRuntimeEnvironmentSchema.parse(entry))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
  } catch {
    throw new RuntimeEnvironmentStoreError(
      'runtime_error',
      `Could not read Orca environments at ${path}; the file is invalid.`
    )
  }
}

/** Persisted environments with their sidecar state overlaid; stale sidecar entries are ignored. */
export function readEnvironmentStore(
  userDataPath: string,
  options: { requireStoreFile?: boolean } = {}
): {
  version: 1
  environments: KnownRuntimeEnvironment[]
} {
  const store = readPersistedEnvironmentStore(userDataPath, options)
  let sidecar: ReturnType<typeof readRuntimeEnvironmentSidecar>
  try {
    sidecar = readRuntimeEnvironmentSidecar(userDataPath)
  } catch (error) {
    // Fail closed like the main file: a link we cannot read may pin a host key we must not drop.
    if (error instanceof RuntimeEnvironmentSidecarInvalidError) {
      throw new RuntimeEnvironmentStoreError('runtime_error', error.message)
    }
    throw error
  }
  return {
    version: 1,
    environments: store.environments.map((environment) =>
      overlayRuntimeEnvironmentSidecar(environment, sidecar.entries[environment.id])
    )
  }
}

/** Writes only persisted fields; sidecar state is written by the sidecar module. */
export function writeEnvironmentStore(userDataPath: string, store: RuntimeEnvironmentStore): void {
  const path = getEnvironmentStorePath(userDataPath)
  try {
    writeSecureJsonFileWithinLimit(
      path,
      RuntimeEnvironmentStoreSchema.parse(store),
      MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES
    )
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new RuntimeEnvironmentStoreError(
        'runtime_error',
        `Could not write Orca environments at ${path}; the store exceeds its durable capacity.`
      )
    }
    throw error
  }
}
