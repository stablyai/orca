import { toast } from 'sonner'
import type { GeneratedAgentInputNotice } from '../../../shared/generated-agent-input-notice'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { GeneratedInputNoticeDelta } from '../../../shared/generated-input-notice-feed'
import { showGeneratedInputNotice } from '@/lib/generated-input-notice-toast'
import {
  dismissGeneratedInputNotice,
  settleGeneratedInputNotice,
  type GeneratedInputNoticeHost
} from './generated-input-notice-registration'

type Source = {
  notice: GeneratedAgentInputNotice
  session: string
  owner?: GeneratedInputNoticeHost
}
// One toast per operation, whichever runtimes hold it: this window's own runtime ('local') may hold
// a copy of a request that a paired host also keeps. A replaced or replayed subscription
// reconciles only its own source once its snapshot is complete, instead of stranding toasts.
type Entry = { sources: Map<string, Source>; showing: Source | null; observed: Map<string, string> }
const shown = new Map<string, Entry>()
const idsBySource = new Map<string, Set<string>>()
// Discarded here, or by this window before a reload while its host had not applied it yet.
const discarded = new Set<string>()
// The local snapshot includes offline discards. Read it before any paired host can publish
// the copies those discards suppress, including when the host answers first after a reload.
let localSnapshotResolved!: () => void
export const localGeneratedInputNoticeSnapshot = new Promise<void>((resolve) => {
  localSnapshotResolved = resolve
})

function render(id: string): void {
  const entry = shown.get(id)
  const toastId = `generated-input:${id}`
  // The host's copy speaks for the request once it has one; else this window's runtime's.
  let source = entry?.sources.get('local') ?? entry?.sources.get('fallback') ?? null
  for (const [key, held] of entry?.sources ?? []) {
    if (key !== 'local' && key !== 'fallback') {
      source = held
      break
    }
  }
  if (!entry || !source || discarded.has(id)) {
    // Forgotten first, so the toast's own dismissal callback finds nothing left to discard.
    forget(id, entry?.sources)
    if (entry?.showing) {
      toast.dismiss(toastId)
    }
    return
  }
  if (entry.showing?.notice === source.notice) {
    return
  }
  entry.showing = source
  showGeneratedInputNotice({ ...source.notice, id: toastId, onDismiss: () => dismiss(id) })
}

function forget(id: string, sources: Map<string, Source> | undefined): void {
  shown.delete(id)
  for (const key of sources?.keys() ?? []) {
    idsBySource.get(key)?.delete(id)
  }
}

function dismiss(id: string): void {
  const entry = shown.get(id)
  if (!entry) {
    return
  }
  discarded.add(id)
  forget(id, entry.sources)
  const host = [...entry.sources.values()].find((source) => source.owner)?.owner
  // This window's runtime discards its copy and owes the host the discard until it applies it.
  void dismissGeneratedInputNotice(id, host).catch(() => {
    // Failed dismissal is not permission to discard the canonical notice.
    discarded.delete(id)
    shown.set(id, { ...entry, showing: null })
    for (const key of entry.sources.keys()) {
      idsBySource.get(key)?.add(id)
    }
    render(id)
  })
}

function addSource(
  key: string,
  notice: GeneratedAgentInputNotice,
  session: string,
  owner?: GeneratedInputNoticeHost
): void {
  let entry = shown.get(notice.id)
  if (!entry) {
    entry = { sources: new Map(), showing: null, observed: new Map() }
    shown.set(notice.id, entry)
  }
  const held = entry.sources.get(key)
  if (held?.session !== session || !sameNotice(held.notice, notice)) {
    entry.sources.set(key, { notice, session, ...(owner ? { owner } : {}) })
  }
  const ids = idsBySource.get(key) ?? new Set<string>()
  idsBySource.set(key, ids)
  ids.add(notice.id)
  if (key === 'local') {
    entry.sources.delete('fallback')
    idsBySource.get('fallback')?.delete(notice.id)
  }
  render(notice.id)
  const local = entry.sources.get('local')
  if (!local || discarded.has(notice.id)) {
    return
  }
  for (const [sourceKey, source] of entry.sources) {
    if (!source.owner) {
      continue
    }
    const proof = JSON.stringify([local.session, source.session, source.owner])
    if (entry.observed.get(sourceKey) !== proof) {
      entry.observed.set(sourceKey, proof)
      // Only actual overlap needs retirement; main validates the fixed receipt.
      settleGeneratedInputNotice(notice.id, source.owner)
    }
  }
}

/** A lost registration answer joins the same presentation and discard path as its late record. */
export function projectFallbackGeneratedInputNotice(args: {
  operationId: string
  text: string
  agent?: TuiAgent | null
  certainty?: 'not-sent' | 'unconfirmed'
  submitted?: boolean
}): void {
  addSource(
    'fallback',
    {
      id: args.operationId,
      text: args.text,
      agent: args.agent ?? null,
      certainty: args.certainty ?? 'not-sent',
      handle: '',
      worktreeId: '',
      ptyId: null,
      ...(args.submitted === undefined ? {} : { submitted: args.submitted })
    },
    'fallback'
  )
}

/** Project one runtime's notices into this window's toasts. */
export function projectGeneratedInputNotices(
  target: RuntimeClientTarget,
  owner?: GeneratedInputNoticeHost
) {
  const key = target.kind === 'local' ? 'local' : target.environmentId
  const ids = idsBySource.get(key) ?? new Set<string>()
  idsBySource.set(key, ids)
  const add = (notice: GeneratedAgentInputNotice, session: string): void =>
    addSource(key, notice, session, owner)
  const remove = (id: string): void => {
    ids.delete(id)
    const entry = shown.get(id)
    entry?.sources.delete(key)
    if (key === 'local') {
      entry?.observed.clear()
    } else {
      entry?.observed.delete(key)
    }
    render(id)
  }
  return {
    // A (re)subscription's complete view: one pass over this source's notices and what is wanted.
    onSnapshot: (
      notices: GeneratedAgentInputNotice[],
      session: string,
      withheld: string[]
    ): void => {
      toast.batch(() => {
        for (const id of withheld) {
          discarded.add(id)
          render(id)
        }
        const wanted = new Map(notices.map((notice) => [notice.id, notice]))
        for (const id of ids) {
          if (
            wanted.get(id) === undefined ||
            shown.get(id)?.sources.get(key)?.session !== session
          ) {
            remove(id)
          }
        }
        for (const notice of notices) {
          add(notice, session)
        }
        if (key === 'local') {
          localSnapshotResolved()
        }
      })
    },
    // A live change touches only its own toast.
    onDelta: (delta: GeneratedInputNoticeDelta, session: string): void =>
      delta.kind === 'added' ? add(delta.notice, session) : remove(delta.id)
  }
}

function sameNotice(a: GeneratedAgentInputNotice, b: GeneratedAgentInputNotice): boolean {
  return (
    a.text === b.text &&
    a.agent === b.agent &&
    a.certainty === b.certainty &&
    a.submitted === b.submitted &&
    a.ptyId === b.ptyId &&
    a.handle === b.handle &&
    a.worktreeId === b.worktreeId
  )
}

export function resolveLocalGeneratedInputNoticeSnapshot(): void {
  localSnapshotResolved()
}
