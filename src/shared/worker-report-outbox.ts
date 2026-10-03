import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import lockfile from 'proper-lockfile'
import {
  readWorkerReportFile,
  secureWorkerReportPath,
  syncWorkerReportDirectory,
  writeWorkerReportFile
} from './worker-report-storage'
import {
  WorkerReportInputSchema,
  WorkerReportRecordSchema,
  WorkerReportRejectionSchema,
  WORKER_REPORT_MAX_RECORDS,
  WORKER_REPORT_REJECTION_RETENTION_MS,
  type WorkerReportInput,
  type WorkerReportRecord
} from './worker-report-record'

export class WorkerReportOutbox {
  readonly directory: string
  constructor(userDataPath: string) {
    this.directory = join(userDataPath, 'worker-report-outbox')
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await secureWorkerReportPath(this.directory, true)
    const release = await lockfile.lock(this.directory, {
      realpath: false,
      retries: { retries: 10, minTimeout: 10, maxTimeout: 100 },
      stale: 60_000
    })
    try {
      return await action()
    } finally {
      await release()
    }
  }

  private path(requestId: string): string {
    return join(this.directory, `${createHash('sha256').update(requestId).digest('hex')}.json`)
  }

  async enqueue(value: WorkerReportInput, now = Date.now()): Promise<WorkerReportRecord> {
    const input = WorkerReportInputSchema.parse(value)
    return this.locked(async () => {
      const names = await readdir(this.directory)
      await this.pruneArtifacts(names, now)
      const path = this.path(input.requestId)
      if (names.some((name) => join(this.directory, name) === path)) {
        const record = WorkerReportRecordSchema.safeParse(await readWorkerReportFile(path))
        if (!record.success) {
          throw new Error('Worker report was explicitly rejected; inspect its rejection record')
        }
        if (JSON.stringify(record.data.input) !== JSON.stringify(input)) {
          throw new Error('Worker report request already has different input')
        }
        return record.data
      }
      await this.pruneRejections(names, now)
      if ((await readdir(this.directory)).length >= WORKER_REPORT_MAX_RECORDS) {
        throw new Error('Worker report outbox is full; no report was sent')
      }
      const record: WorkerReportRecord = {
        version: 1,
        input,
        createdAt: now,
        nextAttemptAt: now,
        attempts: 0
      }
      await writeWorkerReportFile(path, record)
      return record
    })
  }

  private async pruneRejections(names: string[], now: number): Promise<void> {
    for (const name of names.filter((name) => name.endsWith('.json'))) {
      const path = join(this.directory, name)
      const value = await this.readOrQuarantine(path)
      const rejected = WorkerReportRejectionSchema.safeParse(value)
      if (
        rejected.success &&
        now - rejected.data.rejectedAt > WORKER_REPORT_REJECTION_RETENTION_MS
      ) {
        await unlink(path)
      }
    }
  }

  private async pruneArtifacts(names: string[], now: number): Promise<void> {
    for (const name of names.filter(
      (name) => name.endsWith('.quarantined') || name.endsWith('.tmp')
    )) {
      const path = join(this.directory, name)
      const stat = await lstat(path)
      if (now - stat.ctimeMs > WORKER_REPORT_REJECTION_RETENTION_MS) {
        await unlink(path)
      }
    }
  }

  private async readOrQuarantine(path: string): Promise<unknown> {
    try {
      const value = await readWorkerReportFile(path)
      const pending = WorkerReportRecordSchema.safeParse(value)
      if (pending.success && this.path(pending.data.input.requestId) !== path) {
        throw new Error('Worker report filename and identity disagree')
      }
      if (
        !WorkerReportRecordSchema.safeParse(value).success &&
        !WorkerReportRejectionSchema.safeParse(value).success
      ) {
        throw new Error('Invalid worker report record')
      }
      return value
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined
      }
      // Move the directory entry itself; never follow an untrusted symlink or log its contents.
      await rename(path, `${path}.quarantined`)
      await syncWorkerReportDirectory(this.directory)
      console.error(
        '[orchestration] Invalid or inaccessible worker report quarantined; inspect this profile outbox.'
      )
      return undefined
    }
  }

  async pending(): Promise<WorkerReportRecord[]> {
    return this.locked(async () => {
      const records: WorkerReportRecord[] = []
      const names = await readdir(this.directory)
      await this.pruneArtifacts(names, Date.now())
      for (const name of names.filter((name) => name.endsWith('.json'))) {
        const value = await this.readOrQuarantine(join(this.directory, name))
        if (value === undefined || WorkerReportRejectionSchema.safeParse(value).success) {
          continue
        }
        records.push(WorkerReportRecordSchema.parse(value))
      }
      return records.sort((a, b) => a.createdAt - b.createdAt)
    })
  }

  async claim(requestId: string, now: number): Promise<WorkerReportRecord | null> {
    return this.locked(async () => {
      const path = this.path(requestId)
      const parsed = WorkerReportRecordSchema.safeParse(await this.readOrQuarantine(path))
      if (!parsed.success || parsed.data.nextAttemptAt > now) {
        return null
      }
      const record = parsed.data
      record.attempts++
      record.nextAttemptAt = now + Math.min(300_000, 30_000 * 2 ** Math.min(record.attempts - 1, 4))
      await writeWorkerReportFile(path, record)
      return record
    })
  }

  async settle(requestId: string, code?: string, now = Date.now()): Promise<void> {
    await this.locked(async () => {
      const path = this.path(requestId)
      const parsed = WorkerReportRecordSchema.safeParse(await this.readOrQuarantine(path))
      if (!parsed.success) {
        return
      }
      if (code) {
        const target = JSON.parse(parsed.data.input.params.payload)
        await writeWorkerReportFile(
          path,
          WorkerReportRejectionSchema.parse({
            version: 1,
            requestId,
            code,
            rejectedAt: now,
            taskId: target.taskId,
            dispatchId: target.dispatchId
          })
        )
      } else {
        await unlink(path)
        await syncWorkerReportDirectory(this.directory)
      }
    })
  }
}
