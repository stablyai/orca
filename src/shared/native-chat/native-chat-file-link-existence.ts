import type { ParsedTerminalFileLink } from '../terminal/links/terminal-links'
import type { FileLinkExists } from './native-chat-file-link-tree'
import { readRecentPathAnswer, writeRecentPathAnswer } from '../recent-path-answers'

// Why: a host that could not answer is retried a few times, then waits for the next recheck.
export const UNVERIFIABLE_RETRY_DELAYS_MS = [2_000, 10_000, 30_000] as const

/** The lookups one rendered message makes; a new snapshot means one of its answers changed. */
export type NativeChatFileLinkSnapshot = {
  /** Asks the host about unknown or outdated paths. */
  check: FileLinkExists
  /** Answers from what is already known; for text still streaming in. */
  peek: FileLinkExists
}

export type NativeChatFileLinkWatcher = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => NativeChatFileLinkSnapshot
}

export type NativeChatFileLinkExistence = {
  watch: () => NativeChatFileLinkWatcher
  /** Files may have changed (a turn ended, the host came back): ask again about every watched path. */
  recheck: () => void
}

/** What a detected path needs: `linked` without asking, `plain` never asked, or a host answer for `key`. */
export type NativeChatFileLinkLookup<Target> =
  | { kind: 'linked' }
  | { kind: 'plain' }
  | { kind: 'ask'; key: string; target: Target }

export type NativeChatFileLinkHostAccess<Target> = {
  lookup: (link: ParsedTerminalFileLink) => NativeChatFileLinkLookup<Target>
  /** Rejects when the host cannot answer, so an outage is never taken as a missing file. */
  ask: (target: Target) => Promise<boolean>
}

/** The generation is the recheck an answer was asked in; older answers still show but are re-asked. */
type Answer = { exists: boolean; generation: number }

type WatcherState<Target> = {
  /** Paths this message has an answer for, or asked about, with the answer its render used. */
  held: Map<string, { target: Target; shown: boolean }>
  subscribed: boolean
  refresh: () => void
}

/** One per chat: which detected paths name files on the chat's host, shared by every rendered message. */
export function createNativeChatFileLinkChecker<Target>(
  host: NativeChatFileLinkHostAccess<Target>
): NativeChatFileLinkExistence {
  let generation = 0
  const answers = new Map<string, Answer>()
  /** Generation each outstanding request was sent in. */
  const inFlight = new Map<string, number>()
  /** Paths the host could not answer in this generation, with their pending retry. */
  const failures = new Map<string, { attempt: number; timer?: ReturnType<typeof setTimeout> }>()
  /** Subscribed messages per path; their answers stay live beyond the unobserved cache limit. */
  const holders = new Map<
    string,
    { target: Target; watchers: Set<WatcherState<Target>>; answer?: Answer }
  >()

  const answerFor = (key: string): Answer | undefined =>
    holders.get(key)?.answer ?? answers.get(key)

  const clearFailure = (key: string): void => {
    clearTimeout(failures.get(key)?.timer)
    failures.delete(key)
  }

  const settle = (key: string, sentIn: number, exists: boolean): void => {
    if (inFlight.get(key) === sentIn) {
      inFlight.delete(key)
    }
    const previous = answerFor(key)
    // Why: a reply to an older question must not overwrite what a newer one found.
    if (previous && previous.generation > sentIn) {
      return
    }
    if (sentIn === generation) {
      clearFailure(key)
    }
    const held = holders.get(key)
    if (held) {
      held.answer = { exists, generation: sentIn }
    } else {
      writeRecentPathAnswer(answers, key, { exists, generation: sentIn })
    }
    if ((previous?.exists ?? false) !== exists) {
      for (const watcher of holders.get(key)?.watchers ?? []) {
        watcher.refresh()
      }
    }
  }

  const fail = (key: string, sentIn: number): void => {
    if (inFlight.get(key) === sentIn) {
      inFlight.delete(key)
    }
    // Retry only current watched requests; an unreachable host does not prove a file missing.
    if (sentIn !== generation || !holders.has(key)) {
      return
    }
    const attempt = (failures.get(key)?.attempt ?? -1) + 1
    const delay = UNVERIFIABLE_RETRY_DELAYS_MS[attempt]
    clearTimeout(failures.get(key)?.timer)
    failures.set(key, {
      attempt,
      timer: delay === undefined ? undefined : setTimeout(() => retry(key), delay)
    })
  }

  const send = (key: string, target: Target): void => {
    if (inFlight.get(key) === generation) {
      return
    }
    const sentIn = generation
    inFlight.set(key, sentIn)
    void host.ask(target).then(
      (exists) => settle(key, sentIn, exists),
      () => fail(key, sentIn)
    )
  }

  const retry = (key: string): void => {
    const failure = failures.get(key)
    const held = holders.get(key)
    if (!failure) {
      return
    }
    failure.timer = undefined
    if (held) {
      send(key, held.target)
    } else {
      failures.delete(key)
    }
  }

  const index = (watcher: WatcherState<Target>, key: string, target: Target): void => {
    const entry = holders.get(key) ?? { target, watchers: new Set<WatcherState<Target>>() }
    const cached = answers.get(key)
    if (cached) {
      entry.answer = cached
      answers.delete(key)
    }
    entry.watchers.add(watcher)
    holders.set(key, entry)
  }

  const unindex = (watcher: WatcherState<Target>): void => {
    for (const key of watcher.held.keys()) {
      const entry = holders.get(key)
      entry?.watchers.delete(watcher)
      if (entry?.watchers.size === 0) {
        holders.delete(key)
        if (entry.answer) {
          writeRecentPathAnswer(answers, key, entry.answer)
        }
        // Why: nothing shows this path any more, so its retries end here.
        clearFailure(key)
      }
    }
  }

  const lookup = (
    link: ParsedTerminalFileLink,
    watcher: WatcherState<Target>,
    mayAsk: boolean
  ): boolean => {
    const found = host.lookup(link)
    if (found.kind !== 'ask') {
      return found.kind === 'linked'
    }
    const { key, target } = found
    const answer = holders.get(key)?.answer ?? readRecentPathAnswer(answers, key)
    if (!answer && !mayAsk) {
      return false
    }
    const shown = answer?.exists ?? false
    watcher.held.set(key, { target, shown })
    if (watcher.subscribed) {
      index(watcher, key, target)
    }
    if (mayAsk && isOutdated(key)) {
      send(key, target)
    }
    return shown
  }

  const isOutdated = (key: string): boolean =>
    (answerFor(key)?.generation ?? -1) < generation && !failures.has(key)

  // Why: an answer can land between a message's render and its subscribe; nothing would refresh it.
  const catchUp = (watcher: WatcherState<Target>): void => {
    let changed = false
    for (const [key, { target, shown }] of watcher.held) {
      index(watcher, key, target)
      changed ||= (answerFor(key)?.exists ?? false) !== shown
      if (isOutdated(key)) {
        send(key, target)
      }
    }
    if (changed) {
      watcher.refresh()
    }
  }

  return {
    watch: () => {
      const listeners = new Set<() => void>()
      const state: WatcherState<Target> = {
        held: new Map(),
        subscribed: false,
        refresh: () => {}
      }
      const createSnapshot = (): NativeChatFileLinkSnapshot => ({
        check: (link) => lookup(link, state, true),
        peek: (link) => lookup(link, state, false)
      })
      let snapshot = createSnapshot()
      state.refresh = () => {
        snapshot = createSnapshot()
        for (const listener of listeners) {
          listener()
        }
      }
      return {
        subscribe: (listener) => {
          listeners.add(listener)
          if (!state.subscribed) {
            state.subscribed = true
            catchUp(state)
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0 && state.subscribed) {
              state.subscribed = false
              unindex(state)
            }
          }
        },
        getSnapshot: () => snapshot
      }
    },
    recheck: () => {
      generation += 1
      for (const { timer } of failures.values()) {
        clearTimeout(timer)
      }
      failures.clear()
      // Why: messages keep showing their answers; only those whose answer changes re-render.
      for (const [key, { target }] of holders) {
        send(key, target)
      }
    }
  }
}
