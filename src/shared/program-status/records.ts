import {
  programStatusStateOutlivesProgram,
  type ProgramStatusKind,
  type ProgramStatusReport,
  type ProgramStatusState
} from './protocol'

export type ProgramStatusRecord = {
  /** Null is the root record. */
  id: string | null
  state: ProgramStatusState
  kind?: ProgramStatusKind
  progress?: number
  /** Own `app`, or the nearest ancestor's when the report omitted it. */
  app?: string
  title?: string
  msg?: string
}

/** Spec ceiling; LRU-evicted past it so a runaway program cannot grow memory. */
export const PROGRAM_STATUS_MAX_RECORDS = 256

const ROOT_KEY = ''

function isAtOrBeneath(id: string, ancestor: string): boolean {
  return id === ancestor || id.startsWith(`${ancestor}/`)
}

/** One terminal's OSC 7501 records. Mutators return whether anything changed. */
export class ProgramStatusRecordSet {
  // Map order doubles as least-recently-updated order: every write re-inserts its key.
  private readonly records = new Map<
    string,
    Omit<ProgramStatusRecord, 'app'> & { ownApp?: string }
  >()

  apply(report: ProgramStatusReport): boolean {
    const key = report.id ?? ROOT_KEY
    if (report.state === 'clear') {
      if (report.id === null) {
        return this.reset()
      }
      let changed = false
      for (const existing of this.records.keys()) {
        if (existing !== ROOT_KEY && isAtOrBeneath(existing, key)) {
          this.records.delete(existing)
          changed = true
        }
      }
      return changed
    }
    // Each report replaces its record whole; a key missing here is missing afterwards.
    this.records.delete(key)
    if (this.records.size >= PROGRAM_STATUS_MAX_RECORDS) {
      const oldest = this.records.keys().next().value
      if (oldest !== undefined) {
        this.records.delete(oldest)
      }
    }
    this.records.set(key, {
      id: report.id,
      state: report.state,
      ...(report.kind !== undefined ? { kind: report.kind } : {}),
      ...(report.progress !== undefined ? { progress: report.progress } : {}),
      ...(report.app !== undefined ? { ownApp: report.app } : {}),
      ...(report.title !== undefined ? { title: report.title } : {}),
      ...(report.msg !== undefined ? { msg: report.msg } : {})
    })
    return true
  }

  /** The program ended (OSC 133 A; PTY exit clears the runtime's live facet alike). */
  endProgram(): boolean {
    let changed = false
    for (const [key, record] of this.records) {
      if (!programStatusStateOutlivesProgram(record.state)) {
        this.records.delete(key)
        changed = true
      }
    }
    return changed
  }

  /** RIS or a root `clear`: every record goes. */
  reset(): boolean {
    const changed = this.records.size > 0
    this.records.clear()
    return changed
  }

  root(): ProgramStatusRecord | undefined {
    return this.resolve(ROOT_KEY)
  }

  /** Non-root records, oldest update first. */
  descendants(): ProgramStatusRecord[] {
    const result: ProgramStatusRecord[] = []
    for (const key of this.records.keys()) {
      if (key !== ROOT_KEY) {
        const record = this.resolve(key)
        if (record) {
          result.push(record)
        }
      }
    }
    return result
  }

  private resolve(key: string): ProgramStatusRecord | undefined {
    const stored = this.records.get(key)
    if (!stored) {
      return undefined
    }
    const { ownApp, ...record } = stored
    const app = ownApp ?? this.inheritedApp(key)
    return app !== undefined ? { ...record, app } : record
  }

  private inheritedApp(key: string): string | undefined {
    let cursor = key
    while (cursor !== ROOT_KEY) {
      const slash = cursor.lastIndexOf('/')
      cursor = slash === -1 ? ROOT_KEY : cursor.slice(0, slash)
      const app = this.records.get(cursor)?.ownApp
      if (app !== undefined) {
        return app
      }
    }
    return undefined
  }
}
