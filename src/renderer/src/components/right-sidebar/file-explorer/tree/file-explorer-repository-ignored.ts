import { GIT_REPOSITORY_IGNORE_BATCH_SIZE } from '../../../../../../shared/git/status/git-repository-status'
import { splitGitCheckIgnorePathsByStdinBytes } from '../../../../../../shared/git/paths/git-check-ignore-stdio'
import type { ExplorerRepositoryRead } from './file-explorer-repository-source'

type Token = object
type FailedPath = { token: Token; dueAt: number }
type IgnoreOwner = {
  read: ExplorerRepositoryRead
  current: () => boolean
  admit: (signal: AbortSignal, run: () => Promise<void>) => Promise<void>
  remove: () => void
  publish: (answers: ReadonlyMap<string, boolean>) => void
}

/** Issued named work outlives demand additions; only input epochs and membership retire its answers. */
export class ExplorerRepositoryIgnoredQueries {
  private members = new Map<string, Token>()
  private pending = new Map<string, Token>()
  private wave = new Map<string, Token>()
  private failures = new Map<string, FailedPath>()
  private controller = new AbortController()
  private active: { members: Map<string, Token>; controller: AbortController } | undefined
  private epoch = 0
  private sweepAt = Infinity
  private retryAt = Infinity
  answers: ReadonlyMap<string, boolean> = new Map()

  constructor(
    private path: string,
    private owner: IgnoreOwner
  ) {}

  nextAt(): number {
    return this.members.size
      ? Math.min(this.pending.size ? -Infinity : Infinity, this.sweepAt, this.retryAt)
      : Infinity
  }

  setDemand(paths: readonly string[]): boolean {
    const wanted = new Set(paths)
    const answers = new Map(this.answers)
    let changed = false
    for (const path of this.members.keys()) {
      if (!wanted.has(path)) {
        this.members.delete(path)
        this.pending.delete(path)
        this.wave.delete(path)
        this.failures.delete(path)
        changed = answers.delete(path) || changed
      }
    }
    let added = false
    for (const path of paths) {
      if (!this.members.has(path)) {
        const token = {}
        this.members.set(path, token)
        this.pending.set(path, token)
        added = true
      }
    }
    if (changed) {
      this.answers = answers
    }
    if (!paths.length) {
      this.controller.abort()
      this.controller = new AbortController()
      this.epoch++
      this.sweepAt = Infinity
    } else if (this.sweepAt === Infinity && !this.wave.size) {
      this.sweepAt = Date.now() + 60_000
    }
    if (
      this.active &&
      ![...this.active.members].some(([path, token]) => this.members.get(path) === token)
    ) {
      this.active.controller.abort()
    }
    this.retimeFailures()
    return added
  }

  invalidate(): void {
    this.controller.abort()
    this.controller = new AbortController()
    this.epoch++
    this.wave.clear()
    this.pending = new Map(this.members)
    this.failures.clear()
    this.retryAt = Infinity
    this.sweepAt = this.members.size ? -Infinity : Infinity
  }

  private retimeFailures(): void {
    this.retryAt = Infinity
    for (const failure of this.failures.values()) {
      this.retryAt = Math.min(this.retryAt, failure.dueAt)
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    if (!this.members.size || !this.owner.current() || Date.now() < this.nextAt()) {
      return
    }
    const epoch = this.epoch
    const controller = this.controller
    const current = (): boolean =>
      this.owner.current() && !signal.aborted && !controller.signal.aborted && this.epoch === epoch
    const full = Date.now() >= this.sweepAt
    const wave = new Map<string, Token>()
    if (Date.now() >= this.retryAt) {
      for (const [path, failure] of this.failures) {
        if (Date.now() >= failure.dueAt) {
          wave.set(path, failure.token)
        }
      }
    }
    for (const [path, token] of this.pending) {
      wave.set(path, token)
    }
    this.pending.clear()
    if (full) {
      for (const [path, token] of this.members) {
        const failure = this.failures.get(path)
        if (!failure || Date.now() >= failure.dueAt) {
          wave.set(path, token)
        }
      }
    }
    this.wave = wave
    while (wave.size && current()) {
      const candidates: string[] = []
      for (const path of wave.keys()) {
        candidates.push(path)
        if (candidates.length === GIT_REPOSITORY_IGNORE_BATCH_SIZE) {
          break
        }
      }
      const query = splitGitCheckIgnorePathsByStdinBytes(candidates)[0]
      const members = new Map(query.map((path) => [path, wave.get(path)!]))
      const active = { members, controller: new AbortController() }
      this.active = active
      const querySignal = AbortSignal.any([signal, controller.signal, active.controller.signal])
      let ignored: Set<string> | undefined
      try {
        await this.owner.admit(querySignal, async () => {
          const records = await this.owner.read(
            {
              repositoryPaths: [this.path],
              repositoryIntent: 'ignored',
              repositoryQueryPaths: query
            },
            querySignal
          )
          if (!current() || querySignal.aborted) {
            return
          }
          const result = records?.find((record) => record.path === this.path)
          if (result?.kind === 'absent') {
            this.owner.remove()
          } else if (result?.kind === 'repository' && result.ignoredPaths) {
            ignored = new Set(result.ignoredPaths)
          }
        })
      } catch {
        // Unknown chunks settle as exact failed obligations; independent suffixes still advance.
      }
      if (this.active === active) {
        this.active = undefined
      }
      if (!current()) {
        break
      }
      let answers: Map<string, boolean> | undefined
      for (const [path, token] of members) {
        if (wave.get(path) === token) {
          wave.delete(path)
        }
        if (this.members.get(path) !== token) {
          continue
        }
        if (ignored) {
          this.failures.delete(path)
          if (this.answers.get(path) !== ignored.has(path)) {
            answers ??= new Map(this.answers)
            answers.set(path, ignored.has(path))
          }
        } else if (!querySignal.aborted) {
          this.failures.set(path, { token, dueAt: Date.now() + 60_000 })
        }
      }
      if (answers) {
        this.answers = answers
        this.owner.publish(answers)
      }
    }
    if (this.epoch !== epoch) {
      return
    }
    if (current()) {
      // Completion schedules another comprehensive attempt even when some exact paths failed.
      if (full) {
        this.sweepAt = Date.now() + 60_000
      }
    } else {
      for (const [path, token] of wave) {
        if (this.members.get(path) === token) {
          this.pending.set(path, token)
        }
      }
    }
    wave.clear()
    this.retimeFailures()
  }
}
