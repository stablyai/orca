import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from './node-bounded-json-stringify'
import { writeSecureFile } from './secure-file'
import {
  RuntimeEnvironmentStoreSchema,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentStore
} from './runtime-environments'
import {
  overlayRuntimeEnvironmentSidecar,
  readRuntimeEnvironmentSidecar,
  RuntimeEnvironmentSidecarInvalidError
} from './runtime-environment-sidecar'
import {
  getEnvironmentStorePath,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  readEnvironmentStoreRecords,
  type EnvironmentStoreContentReader,
  type EnvironmentStoreRecords,
  backUpBlankEnvironmentStore,
  remoteServerPairingStoreError,
  RuntimeEnvironmentStoreError,
  type EnvironmentStoreRecordsReadOptions,
  warnUnreadableEnvironmentState
} from './runtime-environment-store-records'
import {
  overlayWslHostDeployments,
  readWslHostDeployments,
  WslHostDeploymentStoreInvalidError
} from './wsl-host-deployment-store'
import { isWslHostsServing } from './wsl-host-internal-gate'

export {
  getEnvironmentStorePath,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  RuntimeEnvironmentStoreError,
  type RuntimeEnvironmentStoreErrorCode
} from './runtime-environment-store-records'

/** Readable records only; writeEnvironmentStore preserves unreadable corrupt/newer records verbatim. */
export function readPersistedEnvironmentStore(
  userDataPath: string,
  options: EnvironmentStoreRecordsReadOptions = {}
): RuntimeEnvironmentStore {
  return persistedEnvironmentStoreFromRecords(
    userDataPath,
    readEnvironmentStoreRecords(userDataPath, options)
  )
}

function persistedEnvironmentStoreFromRecords(
  userDataPath: string,
  { environments, unreadable }: EnvironmentStoreRecords
): RuntimeEnvironmentStore {
  if (unreadable.length > 0) {
    warnUnreadableEnvironmentState(
      `Skipping ${unreadable.length} unreadable server record(s) in ${getEnvironmentStorePath(userDataPath)} (ids: ${unreadable.map((record) => record.id ?? '<none>').join(', ')}); they may need a newer version of Orca and are kept on disk.`
    )
  }
  return {
    version: 1,
    environments: environments.sort((a, b) => a.name.localeCompare(b.name))
  }
}

/** Unreadable WSL state fails closed only while WSL hosts are served; otherwise it cannot hide SSH/paired servers. */
function readWslHostDeploymentsForRegistry(
  userDataPath: string,
  readContent?: EnvironmentStoreContentReader
): ReturnType<typeof readWslHostDeployments> {
  const gateOpen = isWslHostsServing(process.env)
  try {
    const read = readWslHostDeployments(userDataPath, readContent)
    return gateOpen ? read : { deployments: read.deployments, unreadableEnvironmentIds: new Set() }
  } catch (error) {
    if (!(error instanceof WslHostDeploymentStoreInvalidError) || gateOpen) {
      throw error
    }
    warnUnreadableEnvironmentState(error.message)
    return { deployments: [], unreadableEnvironmentIds: new Set() }
  }
}

export function readEnvironmentStore(
  userDataPath: string,
  options: EnvironmentStoreRecordsReadOptions = {}
): {
  version: 1
  environments: KnownRuntimeEnvironment[]
} {
  const inputs = readEnvironmentStoreInputs(userDataPath, options)
  return environmentStoreFromInputs(userDataPath, inputs)
}

export function readEnvironmentStoreInputs(
  userDataPath: string,
  options: EnvironmentStoreRecordsReadOptions = {},
  readContent?: EnvironmentStoreContentReader
) {
  const records = readEnvironmentStoreRecords(userDataPath, options, readContent)
  try {
    const sidecar = readRuntimeEnvironmentSidecar(userDataPath, readContent)
    const wslDeployments = readWslHostDeploymentsForRegistry(userDataPath, readContent)
    return { records, sidecar, wslDeployments }
  } catch (error) {
    if (
      error instanceof RuntimeEnvironmentSidecarInvalidError ||
      error instanceof WslHostDeploymentStoreInvalidError
    ) {
      throw new RuntimeEnvironmentStoreError('runtime_error', error.message)
    }
    throw error
  }
}

export function environmentStoreFromInputs(
  userDataPath: string,
  { records, sidecar, wslDeployments }: ReturnType<typeof readEnvironmentStoreInputs>
): { version: 1; environments: KnownRuntimeEnvironment[] } {
  const store = persistedEnvironmentStoreFromRecords(userDataPath, records)
  // Hide unreadable overlays: connecting/editing without them could silently discard SSH pins or deployment ownership.
  const isHidden = (id: string): boolean => Object.hasOwn(sidecar.unreadable, id)
  const hidden = store.environments.filter((environment) => isHidden(environment.id))
  if (hidden.length > 0) {
    warnUnreadableEnvironmentState(
      `Hiding ${hidden.length} server(s) whose links cannot be read (ids: ${hidden.map((environment) => environment.id).join(', ')}); they may need a newer version of Orca.`
    )
  }
  return {
    version: 1,
    environments: overlayWslHostDeployments(
      store.environments
        .filter((environment) => !isHidden(environment.id))
        .map((environment) =>
          overlayRuntimeEnvironmentSidecar(environment, sidecar.entries[environment.id])
        ),
      wslDeployments
    )
  }
}

/** Write persisted fields only; preserve unreadable on-disk records verbatim/in order. Sidecar writes stay separate. */
export function writeEnvironmentStore(userDataPath: string, store: RuntimeEnvironmentStore): void {
  const path = getEnvironmentStorePath(userDataPath)
  const environments = RuntimeEnvironmentStoreSchema.parse(store).environments
  // The new registry replaces a blank file in one atomic write, so no reader sees it emptied early.
  const onDisk = readEnvironmentStoreRecords(userDataPath, { recoverBlankStore: true })
  const readableIds = new Set(onDisk.environments.map((environment) => environment.id))
  const unreadableIds = new Set(onDisk.unreadable.map((record) => record.id))
  // A new readable record must not shadow one a newer build owns under the same id.
  if (environments.some(({ id }) => unreadableIds.has(id) && !readableIds.has(id))) {
    throw remoteServerPairingStoreError('idNeedsNewerOrca')
  }
  let serialized: string
  try {
    serialized = stringifyJsonWithinByteLimit(
      {
        version: 1,
        environments: [...environments, ...onDisk.unreadable.map((record) => record.raw)]
      },
      MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES
    ).serialized
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new RuntimeEnvironmentStoreError(
        'runtime_error',
        `Could not write Orca environments at ${path}; the store exceeds its durable capacity.`
      )
    }
    throw error
  }
  // Copied only once the write is certain to be attempted, so rejected saves leave no copies.
  if (onDisk.blankFile) {
    backUpBlankEnvironmentStore(userDataPath)
  }
  // Without fsync before the rename, a crash can publish the name over NUL-filled data (#18766).
  writeSecureFile(path, serialized, { durable: true })
}
