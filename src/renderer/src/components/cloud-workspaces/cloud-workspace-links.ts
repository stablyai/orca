// App-level wiring for team cloud workspaces: orca://cloud links, presence for the workspace in
// front, and the copy-link shortcut. Installed once from main.tsx; no React tree needed.
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { keybindingMatchesAction } from '../../../../shared/keybindings/matching'
import { parseCloudWorkspaceLink } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { describeError } from './cloud-workspace-errors'
import { copyCloudWorkspaceLink, openCloudWorkspace } from './open-cloud-workspace'
import { cloudWorkspacesAvailable } from './use-cloud-workspaces'

const HIGHLIGHT_MS = 4_000
/** No input for this long and the desktop stops reporting presence (and renewing a lease). */
const IDLE_MS = 15 * 60_000
const TYPING_REPORT_MS = 3_000

let highlightId: string | null = null
let highlightTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
function setHighlight(id: string | null, clearAfterMs?: number): void {
  clearTimeout(highlightTimer)
  highlightTimer =
    clearAfterMs === undefined ? undefined : setTimeout(() => setHighlight(null), clearAfterMs)
  highlightId = id
  listeners.forEach((l) => l())
}

/** The workspace a link pointed at, so Home can ring it while it opens. */
export function useCloudWorkspaceHighlight(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => highlightId
  )
}

export async function handleCloudWorkspaceLink(link: string): Promise<void> {
  const parsed = parseCloudWorkspaceLink(link)
  if (!parsed || !(await cloudWorkspacesAvailable())) {
    return
  }
  setHighlight(parsed.workspaceId)
  const resolved = await window.api.cloudWorkspaces.resolveLink(parsed.workspaceId, parsed.chatId)
  if (!resolved.ok) {
    toast.error(
      resolved.error === 'not_found'
        ? translate(
            'auto.components.cloudWorkspaces.linkNotFound',
            'This link points to a private workspace, another org, or one that was deleted.'
          )
        : describeError(resolved.error, resolved.reason)
    )
    setHighlight(null)
    return
  }
  const outcome = await openCloudWorkspace(resolved.value.workspace)
  if (!outcome.ok) {
    toast.error(outcome.message)
  }
  setHighlight(parsed.workspaceId, HIGHLIGHT_MS)
}

type Front = { sandboxId: string; owner: boolean } | null
let front: Front = null

async function resolveFront(): Promise<Front> {
  const state = useAppStore.getState()
  const worktreeId = state.activeWorktreeId
  const hostId = state.activeWorkspaceExecutionHostId
  if (!worktreeId) {
    return null
  }
  const local = (await window.api.cloudWorkspaces.localWorkspaces()).find(
    (l) => l.worktreeId === worktreeId
  )
  if (local) {
    return { sandboxId: local.sandboxId, owner: true }
  }
  if (hostId) {
    const bindings = await window.api.cloudWorkspaces.environmentBindings()
    for (const [sandboxId, binding] of Object.entries(bindings)) {
      if (toRuntimeExecutionHostId(binding.environmentId) === hostId) {
        return { sandboxId, owner: false }
      }
    }
  }
  return null
}

/** Targets whose own surface answers the chord: a browser guest/overlay, or a list row. */
function shortcutOwnedElsewhere(target: Element | null): boolean {
  return Boolean(
    target?.closest('webview, [data-browser-overlay-tab-id], [data-cloud-workspace-row]')
  )
}

export function installCloudWorkspaceLinks(): () => void {
  const cleanups: (() => void)[] = []
  const api = window.api.cloudWorkspaces
  if (!api) {
    return () => {}
  }
  cleanups.push(
    api.onOpenLink((link) => {
      // The push already delivered it; drain the pending copy so a reload does not replay it.
      void api.consumePendingLink().catch(() => null)
      void handleCloudWorkspaceLink(link)
    })
  )
  void api.consumePendingLink().then((link) => link && void handleCloudWorkspaceLink(link))

  // Presence: report the cloud workspace in front; teammates' desktops also keep its lease alive.
  // A hidden or idle window reports nothing, so an unattended desktop does not hold a VM awake.
  let last = ''
  let sequence = 0
  let idle = false
  const reportable = (): boolean => !idle && document.visibilityState === 'visible'
  const sync = async (): Promise<void> => {
    const ticket = ++sequence
    if (!(await cloudWorkspacesAvailable())) {
      return
    }
    const next = reportable() ? await resolveFront() : null
    // A newer sync started while this one awaited; its answer wins.
    if (ticket !== sequence) {
      return
    }
    const key = next ? `${next.sandboxId}:${next.owner}` : ''
    if (key === last) {
      return
    }
    last = key
    front = next
    await api.setActive(
      next ? { sandboxId: next.sandboxId, leased: !next.owner } : { sandboxId: null }
    )
  }
  cleanups.push(
    useAppStore.subscribe((state, previous) => {
      if (
        state.activeWorktreeId !== previous.activeWorktreeId ||
        state.activeWorkspaceExecutionHostId !== previous.activeWorkspaceExecutionHostId
      ) {
        void sync()
      }
    })
  )
  void sync()

  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const armIdle = (): void => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idle = true
      void sync()
    }, IDLE_MS)
  }
  const onInput = (): void => {
    armIdle()
    if (idle) {
      idle = false
      void sync()
    }
  }
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') {
      onInput()
    } else {
      void sync()
    }
  }
  armIdle()
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pointerdown', onInput, true)
  cleanups.push(() => {
    clearTimeout(idleTimer)
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('pointerdown', onInput, true)
  })

  let lastTypingAt = 0
  const onKeyDown = (event: KeyboardEvent): void => {
    onInput()
    if (!front) {
      return
    }
    const target = event.target instanceof HTMLElement ? event.target : null
    if (
      !event.defaultPrevented &&
      !shortcutOwnedElsewhere(target) &&
      keybindingMatchesAction(
        'cloudWorkspace.copyLink',
        event,
        getShortcutPlatform(),
        useAppStore.getState().keybindings
      )
    ) {
      event.preventDefault()
      void copyCloudWorkspaceLink(front.sandboxId)
      return
    }
    const editing = target?.isContentEditable || target?.tagName === 'TEXTAREA'
    if (
      editing &&
      !event.metaKey &&
      !event.ctrlKey &&
      Date.now() - lastTypingAt > TYPING_REPORT_MS
    ) {
      lastTypingAt = Date.now()
      void api.setActive({ sandboxId: front.sandboxId, typing: true, leased: !front.owner })
    }
  }
  window.addEventListener('keydown', onKeyDown, true)
  cleanups.push(() => window.removeEventListener('keydown', onKeyDown, true))
  const onUnload = (): void => void api.setActive({ sandboxId: null })
  window.addEventListener('beforeunload', onUnload)
  cleanups.push(() => window.removeEventListener('beforeunload', onUnload))
  cleanups.push(() => setHighlight(null))
  return () => cleanups.forEach((c) => c())
}
