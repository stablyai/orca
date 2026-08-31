import { execFileSync } from 'node:child_process'
import type { Page } from '@stablyai/playwright-test'
import { buildWslExecArgs } from '../../../src/shared/wsl-login-shell-command'

/** A WSL-only path makes the stub marker proof that the pane ran in the distro. */
const WSL_STUB_PATH = '/usr/local/bin/golden-stub-agent'
const WSL_STUB_AGENT_LINK = '/usr/local/bin/codex'
const WSL_STUB_BACKUP_PATH = '/usr/local/bin/golden-stub-agent.orca-e2e-backup'
/** mkdir is atomic in the distro, so the lock dir serializes overlapping invocations. */
const WSL_STUB_LOCK_PATH = '/usr/local/bin/golden-stub-agent.orca-e2e-lock'
const WSL_STUB_LINK_MARKER = `${WSL_STUB_LOCK_PATH}/created-codex-link`
const WSL_STUB_STAGED_MARKER = `${WSL_STUB_LOCK_PATH}/staged-stub`
const WSL_STUB_LOCK_STALE_MINUTES = 10
const WSL_STUB_LOCK_WAIT_SECONDS = 60

// Undoes a lock holder that died mid-run, so its leftovers cannot poison later invocations.
const RECLAIM_STALE_LOCK_SCRIPT =
  `if [ -e ${WSL_STUB_LINK_MARKER} ]; then rm -f ${WSL_STUB_AGENT_LINK}; fi; ` +
  `if [ -e ${WSL_STUB_STAGED_MARKER} ]; then rm -f ${WSL_STUB_PATH}; fi; ` +
  `if [ -e ${WSL_STUB_BACKUP_PATH} ] || [ -L ${WSL_STUB_BACKUP_PATH} ]; then ` +
  `mv ${WSL_STUB_BACKUP_PATH} ${WSL_STUB_PATH}; fi; ` +
  `rm -rf ${WSL_STUB_LOCK_PATH}`

const ACQUIRE_LOCK_SCRIPT =
  `mkdir -p /usr/local/bin || exit 1; i=0; ` +
  `while [ $i -lt ${WSL_STUB_LOCK_WAIT_SECONDS} ]; do ` +
  `if mkdir ${WSL_STUB_LOCK_PATH} 2>/dev/null; then printf acquired; exit 0; fi; ` +
  `if [ -n "$(find ${WSL_STUB_LOCK_PATH} -maxdepth 0 -mmin +${WSL_STUB_LOCK_STALE_MINUTES} ` +
  `2>/dev/null)" ]; then ${RECLAIM_STALE_LOCK_SCRIPT}; else sleep 1; fi; i=$((i+1)); ` +
  `done; printf timeout`

// Keep the cross-boundary script newline-free to avoid Windows argv-encoding surprises.
// Moving the entry avoids following and overwriting a pre-existing symlink.
const BACKUP_EXISTING_STUB_SCRIPT =
  `mkdir -p /usr/local/bin && ` +
  `if [ -e ${WSL_STUB_BACKUP_PATH} ] || [ -L ${WSL_STUB_BACKUP_PATH} ]; then exit 1; fi && ` +
  `if [ -e ${WSL_STUB_PATH} ] || [ -L ${WSL_STUB_PATH} ]; then ` +
  `mv ${WSL_STUB_PATH} ${WSL_STUB_BACKUP_PATH} && ` +
  `printf backed-up; else printf none; fi`

// The marker is written first so stale-lock recovery only removes a stub this helper wrote.
const STAGE_SCRIPT =
  `mkdir -p /usr/local/bin && : > ${WSL_STUB_STAGED_MARKER} && ` +
  `printf '#!/bin/sh\\necho GOLDEN_STUB_AGENT_READY\\nexec sleep 3600\\n' > ${WSL_STUB_PATH} && ` +
  `chmod 0755 ${WSL_STUB_PATH}`

// The marker is written before the link so a crashed run over-reports rather than leaks a link.
const STAGE_CODEX_LINK_IF_MISSING_SCRIPT =
  `if [ -e ${WSL_STUB_AGENT_LINK} ] || [ -L ${WSL_STUB_AGENT_LINK} ]; then ` +
  `printf existing; else : > ${WSL_STUB_LINK_MARKER} && ` +
  `ln -s ${WSL_STUB_PATH} ${WSL_STUB_AGENT_LINK} && printf created; fi`

// `;` between steps so the lock is released even when a restore step fails.
function buildRestoreScript(stage: WslGoldenStubAgentStage): string {
  const steps: string[] = []
  if (stage.ownsStubPath) {
    const removed = stage.createdCodexLink
      ? `${WSL_STUB_AGENT_LINK} ${WSL_STUB_PATH}`
      : WSL_STUB_PATH
    steps.push(`rm -f ${removed}`)
    if (stage.backedUpStub) {
      steps.push(`mv ${WSL_STUB_BACKUP_PATH} ${WSL_STUB_PATH}`)
    }
  }
  if (stage.heldLock) {
    steps.push(`rm -rf ${WSL_STUB_LOCK_PATH}`)
  }
  return steps.join(' ; ')
}

// --exec prevents wsl.exe from expanding shell variables in argv.
function runInWslAsRoot(distro: string, script: string): string {
  return execFileSync(
    'wsl.exe',
    ['-u', 'root', ...buildWslExecArgs(distro, ['sh', '-c', script])],
    { encoding: 'utf8', stdio: 'pipe', windowsHide: true }
  )
}

export async function getFirstWslDistro(page: Page): Promise<string | null> {
  const wsl = await page.evaluate(async () => ({
    available: await window.api.wsl.isAvailable(),
    distros: await window.api.wsl.listDistros()
  }))
  return wsl.available ? (wsl.distros[0] ?? null) : null
}

export type WslGoldenStubAgentStage = {
  createdCodexLink: boolean
  backedUpStub: boolean
  ownsStubPath: boolean
  heldLock: boolean
}

/** Returns null when the distro cannot stage the stub. Holds a distro lock until cleanup. */
export function stageWslGoldenStubAgent(distro: string): WslGoldenStubAgentStage | null {
  const stage: WslGoldenStubAgentStage = {
    createdCodexLink: false,
    backedUpStub: false,
    ownsStubPath: false,
    heldLock: false
  }
  try {
    if (runInWslAsRoot(distro, ACQUIRE_LOCK_SCRIPT).trim() !== 'acquired') {
      return null
    }
    stage.heldLock = true
    stage.backedUpStub = runInWslAsRoot(distro, BACKUP_EXISTING_STUB_SCRIPT).trim() === 'backed-up'
    stage.ownsStubPath = true
    runInWslAsRoot(distro, STAGE_SCRIPT)
    stage.createdCodexLink =
      runInWslAsRoot(distro, STAGE_CODEX_LINK_IF_MISSING_SCRIPT).trim() === 'created'
    return stage
  } catch {
    removeWslGoldenStubAgent(distro, stage)
    return null
  }
}

export function removeWslGoldenStubAgent(distro: string, stage: WslGoldenStubAgentStage): void {
  const script = buildRestoreScript(stage)
  if (!script) {
    return
  }
  try {
    runInWslAsRoot(distro, script)
    stage.heldLock = false
    stage.ownsStubPath = false
  } catch {
    // Best-effort cleanup; a leftover stub only affects this fixture's own name.
  }
}

/** Retargets project agent detection and terminal spawning to WSL. */
export async function useWslRuntimeForActiveProject(page: Page, distro: string): Promise<void> {
  await page.evaluate(async (wslDistro) => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store is unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree')
    }
    const activeWorktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((worktree) => worktree.id === worktreeId)
    const activeProject = state.projects.find((project) =>
      activeWorktree ? project.sourceRepoIds.includes(activeWorktree.repoId) : false
    )
    if (!activeProject) {
      throw new Error('No active project')
    }
    await state.updateProject(activeProject.id, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: wslDistro }
    })
  }, distro)
}
