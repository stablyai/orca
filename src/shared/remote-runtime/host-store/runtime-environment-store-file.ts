import { noteEnvironmentStoreWrite } from './runtime-environment-store-write-generation'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../json-stream/node-bounded-json-stringify'
import { writeSecureFile } from '../../secure-storage/secure-file'
import {
  RuntimeEnvironmentStoreSchema,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentStore
} from '../host-catalog/runtime-environments'
import {
  getRuntimeEnvironmentSidecarPath,
  MAX_SIDECAR_FILE_BYTES,
  overlayRuntimeEnvironmentSidecar,
  parseRuntimeEnvironmentSidecarText,
  readRuntimeEnvironmentSidecar,
  type RuntimeEnvironmentSidecar,
  RuntimeEnvironmentSidecarInvalidError
} from './runtime-environment-sidecar'
import {
  getEnvironmentStorePath,
  MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES,
  parseEnvironmentStoreRecordsText,
  readEnvironmentStoreRecords,
  backUpBlankEnvironmentStore,
  remoteServerPairingStoreError,
  RuntimeEnvironmentStoreError,
  type EnvironmentStoreRecords,
  type EnvironmentStoreRecordsReadOptions,
  warnUnreadableEnvironmentState
} from './runtime-environment-store-records'
import {
  getWslHostDeploymentStorePath,
  MAX_WSL_HOST_DEPLOYMENTS_FILE_BYTES,
  overlayWslHostDeployments,
  parseWslHostDeploymentsText,
  readWslHostDeployments,
  type WslHostDeployments,
  WslHostDeploymentStoreInvalidError
} from './wsl-host-deployment-store'
import { createSecureFileContentCache } from './runtime-environment-store-read-cache'
import {
  invalidateEnvironmentStoreObservation,
  environmentStoreServesWsl
} from './runtime-environment-store-observation'

/** Readable records only; writeEnvironmentStore preserves unreadable corrupt/newer records verbatim. */
export function readPersistedEnvironmentStore(
  userDataPath: string,
  options: EnvironmentStoreRecordsReadOptions = {}
): RuntimeEnvironmentStore {
  return persistedStoreFromRecords(userDataPath, readEnvironmentStoreRecords(userDataPath, options))
}

function persistedStoreFromRecords(
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

/**
 * Unreadable WSL state never hides SSH or paired servers. While WSL hosts are served, an unreadable
 * file hides only the servers that could be WSL hosts (it may pin their keys); writes still refuse
 * it, so a newer build's file is kept as it is. With hosts off it hides nothing.
 */
function readWslHostDeploymentsForRegistry(
  readDeployments: () => WslHostDeployments
): WslHostDeployments {
  const gateOpen = environmentStoreServesWsl()
  try {
    const read = readDeployments()
    return gateOpen ? read : { deployments: read.deployments, unreadableEnvironmentIds: new Set() }
  } catch (error) {
    if (!(error instanceof WslHostDeploymentStoreInvalidError)) {
      throw error
    }
    warnUnreadableEnvironmentState(error.message)
    return { deployments: [], unreadableEnvironmentIds: new Set(), fileUnreadable: gateOpen }
  }
}

type MergedEnvironmentStore = {
  version: 1
  environments: KnownRuntimeEnvironment[]
}

const mergedStoreCache = createSecureFileContentCache<MergedEnvironmentStore>()

export function readEnvironmentStore(
  userDataPath: string,
  options: EnvironmentStoreRecordsReadOptions = {}
): MergedEnvironmentStore {
  if (options.requireStoreFile || options.recoverBlankStore) {
    return readEnvironmentStoreUncached(userDataPath, options)
  }
  const storePath = getEnvironmentStorePath(userDataPath)
  const sidecarPath = getRuntimeEnvironmentSidecarPath(userDataPath)
  const wslPath = getWslHostDeploymentStorePath(userDataPath)
  return mergedStoreCache.read(
    `${userDataPath}\0${environmentStoreServesWsl()}`,
    userDataPath,
    [
      { path: storePath, maxBytes: MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES },
      { path: sidecarPath, maxBytes: MAX_SIDECAR_FILE_BYTES },
      { path: wslPath, maxBytes: MAX_WSL_HOST_DEPLOYMENTS_FILE_BYTES }
    ],
    ([storeText, sidecarText, wslText]) =>
      mergeEnvironmentStore(userDataPath, {
        records: () =>
          storeText == null
            ? { environments: [], unreadable: [] }
            : parseEnvironmentStoreRecordsText(storePath, storeText),
        sidecar: () =>
          sidecarText == null
            ? { version: 1, entries: {}, unreadable: {} }
            : parseRuntimeEnvironmentSidecarText(sidecarPath, sidecarText),
        wslDeployments: () =>
          wslText == null
            ? { deployments: [], unreadableEnvironmentIds: new Set() }
            : parseWslHostDeploymentsText(wslPath, wslText)
      }),
    () => readEnvironmentStoreUncached(userDataPath, options)
  )
}

type EnvironmentStoreSources = {
  records: () => EnvironmentStoreRecords
  sidecar: () => RuntimeEnvironmentSidecar
  wslDeployments: () => WslHostDeployments
}

function readEnvironmentStoreUncached(
  userDataPath: string,
  options: EnvironmentStoreRecordsReadOptions
): MergedEnvironmentStore {
  return mergeEnvironmentStore(userDataPath, {
    records: () => readEnvironmentStoreRecords(userDataPath, options),
    sidecar: () => readRuntimeEnvironmentSidecar(userDataPath),
    wslDeployments: () => readWslHostDeployments(userDataPath)
  })
}

function mergeEnvironmentStore(
  userDataPath: string,
  sources: EnvironmentStoreSources
): MergedEnvironmentStore {
  const store = persistedStoreFromRecords(userDataPath, sources.records())
  let sidecar: RuntimeEnvironmentSidecar
  let wslDeployments: WslHostDeployments
  try {
    sidecar = sources.sidecar()
    wslDeployments = readWslHostDeploymentsForRegistry(sources.wslDeployments)
  } catch (error) {
    // Fail closed like the main file: a link we cannot read may pin a host key we must not drop.
    if (
      error instanceof RuntimeEnvironmentSidecarInvalidError ||
      error instanceof WslHostDeploymentStoreInvalidError
    ) {
      throw new RuntimeEnvironmentStoreError('runtime_error', error.message)
    }
    throw error
  }
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
  invalidateEnvironmentStoreObservation(path)
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
  invalidateEnvironmentStoreObservation(path)
  writeSecureFile(path, serialized, { durable: true })
  noteEnvironmentStoreWrite()
}

export { environmentStoreWriteCount } from './runtime-environment-store-write-generation'
