import { reportSecurePathHardening as report } from './secure-path-hardening-report'
import { mayAttemptHardening, recordHardeningOutcome } from './secure-path-hardening-retry-budget'
import { Worker } from 'node:worker_threads'
import { toNamespacedPath } from 'node:path'
import { open, stat } from 'node:fs/promises'
import {
  DEFAULT_HARDENING_CACHE_BOUNDS,
  SecurePathHardeningCache
} from './secure-path-hardening-cache'
import { loadWindowsSecurity, type WindowsSecurity } from './windows-security-addon'
import {
  findPrivateDaclViolation,
  findSecureDaclViolation,
  hardenedDaclSddl
} from './windows-secure-dacl'

type FileOperation = 'createFileWithDacl' | 'readFileWithDacl' | 'getDaclAces' | 'setDaclSddl'
type Pending = { resolve(value: unknown): void; reject(error: Error): void }
let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, Pending>()

function fileOperation(
  security: WindowsSecurity,
  operation: FileOperation,
  args: unknown[]
): Promise<unknown> {
  // Injected test addons have no loadable module or native I/O.
  if (!security.modulePath) {
    const call = security.addon[operation] as (...args: unknown[]) => unknown
    return Promise.resolve(call(...args))
  }
  if (!worker) {
    const current = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads')
      const addon = require(workerData)
      parentPort.on('message', ({ id, operation, args }) => {
        try {
          if (operation === 'createFileWithDacl') args[2] = Buffer.from(args[2])
          parentPort.postMessage({ id, value: addon[operation](...args) })
        } catch (error) {
          parentPort.postMessage({ id, error: String(error), code: error.code })
        }
      })
    `,
      { eval: true, workerData: security.modulePath }
    )
    worker = current
    current.on('message', ({ id, value, error, code }) => {
      const request = pending.get(id)
      pending.delete(id)
      if (error) {
        request?.reject(Object.assign(new Error(error), { code }))
      } else {
        request?.resolve(value)
      }
      if (pending.size === 0) {
        current.unref()
      }
    })
    const fail = (error: Error) => {
      if (worker !== current) {
        return
      }
      worker = undefined
      for (const request of pending.values()) {
        request.reject(error)
      }
      pending.clear()
    }
    current.on('error', fail)
    current.on('exit', () => fail(new Error('Windows credential file worker stopped.')))
  }
  const id = nextId++
  worker.ref()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worker!.postMessage({ id, operation, args })
  })
}

export async function createWindowsCredentialStage(
  path: string,
  data: string | Buffer,
  strict: boolean,
  syncFile = false
): Promise<boolean> {
  const security = loadWindowsSecurity()
  if ('error' in security) {
    if (strict) {
      throw new Error('Private Windows credential-file protection is unavailable.')
    }
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(data)
      if (syncFile) {
        await handle.sync()
      }
    } finally {
      await handle.close()
    }
    return false
  }
  const nativePath = toNamespacedPath(path)
  await fileOperation(security, 'createFileWithDacl', [
    nativePath,
    hardenedDaclSddl(security.userSid, false),
    typeof data === 'string' ? Buffer.from(data) : data,
    strict
  ])
  if (syncFile && !strict) {
    const handle = await open(path, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  try {
    const aces = (await fileOperation(security, 'getDaclAces', [nativePath])) as ReturnType<
      WindowsSecurity['addon']['getDaclAces']
    >
    const invalid = findSecureDaclViolation(aces, security.userSid, false)
    if (invalid) {
      report(path, 'verify', invalid)
    }
    return invalid === null
  } catch (error) {
    report(path, 'verify', String(error))
    return false
  }
}

const hardenedDirectories = new SecurePathHardeningCache<true>(DEFAULT_HARDENING_CACHE_BOUNDS)
const hardenedFiles = new SecurePathHardeningCache<string>(DEFAULT_HARDENING_CACHE_BOUNDS)
async function fileStamp(path: string): Promise<string> {
  const s = await stat(path, { bigint: true })
  return [s.dev, s.ino, s.size, s.mode, s.ctimeNs, s.mtimeNs, s.birthtimeNs].join(':')
}

const hardeningDirectories = new Map<string, Promise<boolean>>()

export function hardenWindowsCredentialPath(path: string, directory: boolean): Promise<boolean> {
  const key = toNamespacedPath(path).toLowerCase()
  if (!directory) {
    return hardenWindowsPath(path, false)
  }
  const pending = hardeningDirectories.get(key)
  if (pending) {
    return pending
  }
  const operation = hardenWindowsPath(path, true)
  hardeningDirectories.set(key, operation)
  void operation.finally(() => hardeningDirectories.delete(key))
  return operation
}

async function hardenWindowsPath(path: string, directory: boolean): Promise<boolean> {
  if (directory && hardenedDirectories.get(path)) {
    return true
  }
  if (!mayAttemptHardening(path)) {
    return false
  }
  try {
    const security = loadWindowsSecurity()
    if ('error' in security) {
      recordHardeningOutcome(path, false)
      return false
    }
    if (!directory && hardenedFiles.get(path) === (await fileStamp(path))) {
      return true
    }
    const remember = async () => {
      if (directory) {
        hardenedDirectories.set(path, true)
      } else {
        hardenedFiles.set(path, await fileStamp(path))
      }
    }
    const nativePath = toNamespacedPath(path)
    const violation = async () =>
      findSecureDaclViolation(
        (await fileOperation(security, 'getDaclAces', [nativePath])) as ReturnType<
          WindowsSecurity['addon']['getDaclAces']
        >,
        security.userSid,
        directory
      )
    if ((await violation()) === null) {
      recordHardeningOutcome(path, true)
      await remember()
      return true
    }
    await fileOperation(security, 'setDaclSddl', [
      nativePath,
      hardenedDaclSddl(security.userSid, directory)
    ])
    const restricted = (await violation()) === null
    recordHardeningOutcome(path, restricted)
    if (restricted) {
      await remember()
    }
    return restricted
  } catch (error) {
    recordHardeningOutcome(path, false)
    report(path, 'apply', String(error))
    return false
  }
}

export async function readPrivateWindowsCredentialFile(
  path: string,
  maxBytes: number
): Promise<Buffer | null> {
  const security = loadWindowsSecurity()
  if ('error' in security) {
    throw new Error('Private Windows credential-file protection is unavailable.')
  }
  const file = (await fileOperation(security, 'readFileWithDacl', [
    toNamespacedPath(path),
    maxBytes
  ])) as ReturnType<WindowsSecurity['addon']['readFileWithDacl']>
  if (!file) {
    return null
  }
  if (findPrivateDaclViolation(file.dacl, security.userSid)) {
    throw new Error('The Windows credential file permits access by another user.')
  }
  return Buffer.from(file.data)
}
