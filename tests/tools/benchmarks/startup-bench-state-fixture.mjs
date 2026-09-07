/**
 * Persisted-state fixtures for the startup benchmark: the git repos, GitHub
 * remotes, restored terminal tabs, and unreachable SSH targets that `orca-data.json`
 * must contain for a run to exercise the corresponding startup path.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function initFixtureGitRepo(repoDir) {
  mkdirSync(repoDir, { recursive: true })
  if (!existsSync(join(repoDir, '.git'))) {
    const init = spawnSync('git', ['init', repoDir], { stdio: 'ignore' })
    if (init.status !== 0) {
      throw new Error(`Failed to create git repo fixture at ${repoDir}`)
    }
  }
  return realpathSync(repoDir)
}

/**
 * Seed repos whose hydration reaches the `gh` login probe: a GitHub `origin`
 * remote and no github.user/user.username config (the bench also points
 * GIT_CONFIG_GLOBAL away from the developer's real config at launch).
 */
function buildGithubRepoFixtures(fixtureDir, githubRepos) {
  const repos = []
  for (let i = 0; i < githubRepos; i++) {
    const repoPath = initFixtureGitRepo(join(fixtureDir, `bench-gh-repo-${i}`))
    const remote = spawnSync(
      'git',
      [
        '-C',
        repoPath,
        'remote',
        'add',
        'origin',
        `https://github.com/orca-bench/bench-gh-repo-${i}.git`
      ],
      { stdio: 'ignore' }
    )
    // Exit 3 (remote exists) is fine on fixture reuse; anything else is not.
    if (remote.status !== 0 && remote.status !== 3) {
      throw new Error(`Failed to add GitHub remote to ${repoPath}`)
    }
    repos.push({
      id: `bench-gh-repo-${i}`,
      path: repoPath,
      displayName: `Bench GH Repo ${i}`,
      badgeColor: '#000000',
      addedAt: 1,
      externalWorktreeVisibility: 'show'
    })
  }
  return repos
}

/**
 * SSH targets on TEST-NET-3 (RFC 5737). The address is guaranteed unroutable,
 * so the TCP handshake never completes and never gets a reset — the wire
 * behaviour of a host that is asleep or behind a dropped VPN.
 */
function buildUnreachableSshTargets(count) {
  const targets = []
  for (let i = 0; i < count; i++) {
    targets.push({
      id: `bench-ssh-unreachable-${i}`,
      label: `Unreachable Host ${i}`,
      host: `203.0.113.${i + 1}`,
      port: 22,
      username: 'orca',
      source: 'manual',
      lastRequiredPassphrase: false
    })
  }
  return targets
}

export function writePersistedStateFixture(
  fixtureDir,
  { stateProfile, sessionTabs, githubRepos, sshUnreachableTargets = 0 }
) {
  const dataPath = join(fixtureDir, 'orca-data.json')
  if (stateProfile === 'none' && githubRepos === 0 && sshUnreachableTargets === 0) {
    try {
      unlinkSync(dataPath)
    } catch {
      // no persisted state fixture
    }
    return 0
  }
  if (!['none', 'restored-local-tabs'].includes(stateProfile)) {
    throw new Error(`Unknown state profile: ${stateProfile}`)
  }

  const githubRepoEntries = buildGithubRepoFixtures(fixtureDir, githubRepos)
  const sshTargets = buildUnreachableSshTargets(sshUnreachableTargets)
  if (stateProfile === 'none') {
    const state = {
      schemaVersion: 1,
      ...(sshTargets.length > 0 ? { sshTargets } : {}),
      repos: githubRepoEntries,
      settings: {
        telemetry: {
          installId: 'startup-bench',
          optedIn: false,
          existedBeforeTelemetryRelease: true
        }
      }
    }
    const json = JSON.stringify(state, null, 2)
    writeFileSync(dataPath, json, 'utf-8')
    return Buffer.byteLength(json)
  }

  const repoPath = initFixtureGitRepo(join(fixtureDir, 'bench-repo'))
  const repoId = 'bench-repo'
  const worktreeId = `${repoId}::${repoPath}`
  const tabCount = Math.max(1, sessionTabs)
  const tabs = []
  const terminalLayoutsByTabId = {}
  const activeTabIdByWorktree = {}
  for (let i = 0; i < tabCount; i++) {
    const tabId = `bench-tab-${String(i).padStart(5, '0')}`
    const ptyId = `bench-pty-${String(i).padStart(5, '0')}`
    tabs.push({
      id: tabId,
      ptyId,
      worktreeId,
      title: `Terminal ${i + 1}`,
      customTitle: null,
      color: null,
      sortOrder: i,
      createdAt: 1
    })
    terminalLayoutsByTabId[tabId] = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null
    }
  }
  activeTabIdByWorktree[worktreeId] = tabs[0]?.id ?? null
  const state = {
    schemaVersion: 1,
    repos: [
      {
        id: repoId,
        path: repoPath,
        displayName: 'Bench Repo',
        badgeColor: '#000000',
        addedAt: 1,
        externalWorktreeVisibility: 'show'
      },
      ...githubRepoEntries
    ],
    settings: {
      telemetry: {
        installId: 'startup-bench',
        optedIn: false,
        existedBeforeTelemetryRelease: true
      }
    },
    ui: {
      lastActiveRepoId: repoId,
      lastActiveWorktreeId: worktreeId
    },
    workspaceSession: {
      activeRepoId: repoId,
      activeWorktreeId: worktreeId,
      activeTabId: tabs[0]?.id ?? null,
      tabsByWorktree: {
        [worktreeId]: tabs
      },
      terminalLayoutsByTabId,
      activeTabIdByWorktree,
      activeWorktreeIdsOnShutdown: [worktreeId],
      defaultTerminalTabsAppliedByWorktreeId: {
        [worktreeId]: true
      },
      // Why on the session and not just the target list: startup reconnect only
      // dials targets that were connected at shutdown.
      ...(sshTargets.length > 0
        ? { activeConnectionIdsAtShutdown: sshTargets.map((target) => target.id) }
        : {})
    }
  }
  if (sshTargets.length > 0) {
    state.sshTargets = sshTargets
  }
  const json = JSON.stringify(state, null, 2)
  writeFileSync(dataPath, json, 'utf-8')
  return Buffer.byteLength(json)
}
