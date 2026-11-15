// CREATE-GH-STEP: the Orca Cloud create wizard's "GitHub access" step. Checked as soon as the create
// starts, in parallel with Start sandbox, so it costs nothing when the Orca GitHub App can already
// push. When it can't, the step asks (Install GitHub App, the installation's settings, or a request
// to copy for an owner) and polls until GitHub says yes; the create holds before Open workspace
// until the step is granted or skipped, so a grant reaches the new sandbox before it opens.
// "Skip for now" is remembered per repository (cloud-create-github-skip.ts): later creates show the
// step as skipped without holding, until the repository has access.
import {
  evaluateCloudCreateGitHubAccess,
  repoNameOf,
  type CloudCreateGitHubAccess,
  type CloudCreateGitHubEvaluation,
  type CloudCreateGitHubGate
} from './cloud-create-github-access-model'
import { emit, entries, subscribe, type Entry } from './cloud-create-github-access-registry'
import { useAppStore } from '@/store'
import { selectWorktreeCreationSurfaceShown } from '@/lib/workspace/creation/worktree-creation-surface'
import { openOrcaGitHubAppInstall } from './cloud-setup-notice-actions'
import {
  forgetGitHubAccessSkip,
  isGitHubAccessSkipped,
  rememberGitHubAccessSkip
} from './cloud-create-github-skip'
import {
  fetchOrcaCloudRepoAccess,
  invalidateOrcaCloudRepoAccess
} from './use-orca-cloud-repo-access'

const FAST_POLL_MS = 2_000
const FAST_POLL_WINDOW_MS = 3 * 60_000
const SLOW_POLL_MS = 10_000
/** A create left waiting this long goes on as if skipped (not remembered). */
const GIVE_UP_MS = 30 * 60_000
/** The check started with the create; a gate never waits longer than this for its first answer. */
const FIRST_ANSWER_WAIT_MS = 5_000

function update(creationId: string, patch: Partial<CloudCreateGitHubAccess>): void {
  const entry = entries.get(creationId)
  if (!entry) {
    return
  }
  entry.state = { ...entry.state, ...patch }
  if (entry.state.phase === 'needed') {
    entry.wasNeeded = true
    entry.neededSince ??= Date.now()
  }
  emit()
}

function settle(creationId: string, gate: CloudCreateGitHubGate): void {
  const entry = entries.get(creationId)
  if (!entry) {
    return
  }
  const waiters = entry.waiters.splice(0)
  for (const resolve of waiters) {
    resolve(gate)
  }
  if (entry.state.holding) {
    entry.state = { ...entry.state, holding: false }
    emit()
  }
}

function creationExists(creationId: string): boolean {
  return Boolean(useAppStore.getState().pendingWorktreeCreations[creationId])
}

let watchingCreations = false

/** A create that leaves the store (opened, cancelled, dismissed) stops its polls and any wait. */
function watchCreations(): void {
  if (watchingCreations) {
    return
  }
  watchingCreations = true
  useAppStore.subscribe((state) => {
    for (const creationId of entries.keys()) {
      if (!state.pendingWorktreeCreations[creationId]) {
        disposeCloudCreateGitHubAccess(creationId)
      }
    }
  })
}

/** Starts the step for a create (again on Retry). `repoUrl` null: not a GitHub repository, no step. */
export function beginCloudCreateGitHubAccess(creationId: string, repoUrl: string | null): void {
  watchCreations()
  const previous = entries.get(creationId)
  if (previous?.timer) {
    clearTimeout(previous.timer)
  }
  if (previous) {
    settle(creationId, { proceed: false, grantedDuringCreate: false })
  }
  if (!repoUrl) {
    entries.delete(creationId)
    emit()
    return
  }
  const repoName = repoNameOf(repoUrl)
  const entry: Entry = {
    state: {
      repoUrl,
      repoName,
      owner: repoName.split('/')[0] ?? '',
      phase: 'checking',
      opened: false,
      remembered: false,
      holding: false
    },
    generation: (previous?.generation ?? 0) + 1,
    neededSince: null,
    wasNeeded: false,
    timer: null,
    waiters: []
  }
  entries.set(creationId, entry)
  emit()
  const generation = entry.generation
  void fetchOrcaCloudRepoAccess(repoUrl, { force: true })
    .then((answer) => evaluateCloudCreateGitHubAccess(repoUrl, answer))
    .catch((): CloudCreateGitHubEvaluation => ({ phase: 'hidden' }))
    .then((result) => {
      if (entries.get(creationId)?.generation !== generation) {
        return
      }
      if (result.phase !== 'needed') {
        if (result.phase === 'ok') {
          // Access arrived since a skip: the step shows its check mark and stops asking.
          forgetGitHubAccessSkip(repoUrl)
        }
        update(creationId, { phase: result.phase })
        settle(creationId, { proceed: true, grantedDuringCreate: false })
        return
      }
      if (isGitHubAccessSkipped(repoUrl)) {
        update(creationId, {
          phase: 'skipped',
          remembered: true,
          ask: result.ask,
          ...(result.configureUrl ? { configureUrl: result.configureUrl } : {})
        })
        settle(creationId, { proceed: true, grantedDuringCreate: false })
        return
      }
      update(creationId, {
        phase: 'needed',
        ask: result.ask,
        ...(result.configureUrl ? { configureUrl: result.configureUrl } : {})
      })
      schedulePoll(creationId)
    })
}

function schedulePoll(creationId: string, delayMs?: number): void {
  const entry = entries.get(creationId)
  if (!entry || entry.state.phase !== 'needed') {
    return
  }
  if (entry.timer) {
    clearTimeout(entry.timer)
  }
  const elapsed = Date.now() - (entry.neededSince ?? Date.now())
  const generation = entry.generation
  entry.timer = setTimeout(
    () => {
      entry.timer = null
      void pollOnce(creationId, generation)
    },
    delayMs ?? (elapsed < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS)
  )
}

async function pollOnce(creationId: string, generation: number): Promise<void> {
  const entry = entries.get(creationId)
  if (!entry || entry.generation !== generation || entry.state.phase !== 'needed') {
    return
  }
  if (!creationExists(creationId)) {
    disposeCloudCreateGitHubAccess(creationId)
    return
  }
  if (entry.neededSince !== null && Date.now() - entry.neededSince > GIVE_UP_MS) {
    // Nobody answered: go on as a skip for this create only; the toast after create stays.
    update(creationId, { phase: 'skipped' })
    settle(creationId, { proceed: true, grantedDuringCreate: false })
    return
  }
  invalidateOrcaCloudRepoAccess(entry.state.repoUrl)
  const answer = await fetchOrcaCloudRepoAccess(entry.state.repoUrl, { force: true }).catch(
    () => null
  )
  if (entries.get(creationId)?.generation !== generation || entry.state.phase !== 'needed') {
    return
  }
  if (answer?.push === 'ok' || answer?.access === 'granted') {
    markGranted(creationId)
    return
  }
  // An owner approved part of the way (requested), or the installation now exists without this repo.
  if (answer?.access === 'requested' && entry.state.ask !== 'requested') {
    update(creationId, { ask: 'requested' })
  } else if (answer?.push === 'repo_not_selected' && entry.state.ask === 'install') {
    update(creationId, {
      ask: 'configure',
      ...(answer.configureUrl ? { configureUrl: answer.configureUrl } : {})
    })
  }
  schedulePoll(creationId)
}

function markGranted(creationId: string): void {
  const entry = entries.get(creationId)
  if (!entry) {
    return
  }
  forgetGitHubAccessSkip(entry.state.repoUrl)
  update(creationId, { phase: 'granted', opened: false })
  settle(creationId, { proceed: true, grantedDuringCreate: entry.wasNeeded })
}

/** Install GitHub App / Add the repository on GitHub: opens GitHub, then keeps polling. */
export function openCloudCreateGitHubAccess(creationId: string): void {
  const entry = entries.get(creationId)
  if (!entry || entry.state.phase !== 'needed') {
    return
  }
  const { repoUrl, configureUrl, ask } = entry.state
  const opened =
    ask === 'configure' && configureUrl
      ? window.api.shell.openUrl(configureUrl).then(
          () => true,
          () => openOrcaGitHubAppInstall(repoUrl)
        )
      : openOrcaGitHubAppInstall(repoUrl)
  void opened.then((ok) => {
    if (ok && entries.get(creationId) === entry) {
      update(creationId, { opened: true })
      // Back from the browser: ask now instead of at the next poll.
      schedulePoll(creationId, 0)
    }
  })
}

/** Orca regained focus (an install finished in the browser): check now. */
export function recheckCloudCreateGitHubAccess(creationId: string): void {
  schedulePoll(creationId, 0)
}

/** "Skip for now": the create goes on, and later creates of this repository don't hold for it. */
export function skipCloudCreateGitHubAccess(creationId: string): void {
  const entry = entries.get(creationId)
  if (!entry || entry.state.phase !== 'needed') {
    return
  }
  if (entry.timer) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
  rememberGitHubAccessSkip(entry.state.repoUrl)
  update(creationId, { phase: 'skipped', remembered: false, opened: false })
  settle(creationId, { proceed: true, grantedDuringCreate: false })
}

/**
 * "Set up" on a skipped step: asks again (and polls). The create isn't held a second time; a grant
 * that lands before Open still reaches the sandbox.
 */
export function reopenCloudCreateGitHubAccess(creationId: string): void {
  const entry = entries.get(creationId)
  if (!entry || entry.state.phase !== 'skipped' || !entry.state.ask) {
    return
  }
  forgetGitHubAccessSkip(entry.state.repoUrl)
  entry.neededSince = null
  update(creationId, { phase: 'needed', remembered: false })
  schedulePoll(creationId)
}

/**
 * Before Open workspace: proceeds at once unless the step is asking; then waits for a grant or
 * Skip. A create whose sheet isn't on screen isn't held (it goes on as a skip for this create).
 * `proceed: false`: the create was cancelled or retried while waiting.
 */
export async function gateCloudCreateOnGitHubAccess(
  creationId: string
): Promise<CloudCreateGitHubGate> {
  const entry = entries.get(creationId)
  if (!entry) {
    return { proceed: true, grantedDuringCreate: false }
  }
  if (entry.state.phase === 'checking') {
    // Started with the create, so normally answered long before the sandbox is up.
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      }
      const timer = setTimeout(done, FIRST_ANSWER_WAIT_MS)
      const unsubscribe = subscribe(() => {
        if (entries.get(creationId) !== entry || entry.state.phase !== 'checking') {
          done()
        }
      })
    })
    if (entries.get(creationId) !== entry) {
      return { proceed: false, grantedDuringCreate: false }
    }
  }
  if (entry.state.phase === 'granted') {
    return { proceed: true, grantedDuringCreate: entry.wasNeeded }
  }
  if (entry.state.phase !== 'needed') {
    return { proceed: true, grantedDuringCreate: false }
  }
  const state = useAppStore.getState()
  if (state.activePendingCreationId !== creationId || !selectWorktreeCreationSurfaceShown(state)) {
    return { proceed: true, grantedDuringCreate: false }
  }
  const held = new Promise<CloudCreateGitHubGate>((resolve) => entry.waiters.push(resolve))
  update(creationId, { holding: true })
  return held
}

/** The create is gone (opened, cancelled, dismissed): stop polling and release any wait. */
export function disposeCloudCreateGitHubAccess(creationId: string): void {
  const entry = entries.get(creationId)
  if (!entry) {
    return
  }
  if (entry.timer) {
    clearTimeout(entry.timer)
  }
  settle(creationId, { proceed: false, grantedDuringCreate: false })
  entries.delete(creationId)
  emit()
}

export type {
  CloudCreateGitHubAccess,
  CloudCreateGitHubAsk,
  CloudCreateGitHubGate
} from './cloud-create-github-access-model'
