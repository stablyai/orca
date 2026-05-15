/* eslint-disable max-lines -- Why: the web preload adapter is the browser-side
   replacement for Electron preload, so the compatibility surface is necessarily
   centralized at this boundary. */
import type { PreloadApi, PreflightStatus, RefreshAgentsResult } from '../../../preload/api-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  DirEntry,
  GlobalSettings,
  MemorySnapshot,
  OnboardingState,
  Repo,
  SearchResult,
  StatsSummary,
  Worktree
} from '../../../shared/types'
import {
  getDefaultOnboardingState,
  getDefaultSettings,
  getDefaultUIState,
  getDefaultWorkspaceSession
} from '../../../shared/constants'
import { createE2EConfig } from '../../../shared/e2e-config'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import {
  clearStoredWebRuntimeEnvironment,
  createStoredWebRuntimeEnvironment,
  getPreferredWebPairingOffer,
  readStoredWebRuntimeEnvironment,
  redactStoredWebRuntimeEnvironment,
  saveStoredWebRuntimeEnvironment,
  updateStoredEnvironmentRuntimeId,
  type StoredWebRuntimeEnvironment
} from './web-runtime-environment'
import { parseWebPairingInput } from './web-pairing'
import { WebRuntimeClient } from './web-runtime-client'

const SETTINGS_STORAGE_KEY = 'orca.web.settings.v1'
const UI_STORAGE_KEY = 'orca.web.ui.v1'
const SESSION_STORAGE_KEY = 'orca.web.workspaceSession.v1'
const ONBOARDING_STORAGE_KEY = 'orca.web.onboarding.v1'
const GITHUB_CACHE_STORAGE_KEY = 'orca.web.githubCache.v1'

let activeEnvironment: StoredWebRuntimeEnvironment | null = readStoredWebRuntimeEnvironment()
let activeClient: WebRuntimeClient | null = null
let activeClientEnvironmentId: string | null = null
let cachedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null = null

type WebSettingsApi = NonNullable<PreloadApi['settings']>

export function installWebPreloadApi(): void {
  activeEnvironment = readStoredWebRuntimeEnvironment()
  const webWindow = window as unknown as { __ORCA_WEB_CLIENT__?: boolean }
  webWindow.__ORCA_WEB_CLIENT__ = true
  window.electron = createFallbackProxy(['electron']) as Window['electron']
  window.api = withFallback(createWebPreloadApi(), []) as PreloadApi
}

function createWebPreloadApi(): Partial<PreloadApi> {
  return {
    app: {
      getFeatureWallAssetBaseUrl: () => Promise.resolve('/'),
      relaunch: () => Promise.resolve(window.location.reload()),
      getKeyboardInputSourceId: () => Promise.resolve(null),
      setUnreadDockBadgeCount: () => Promise.resolve(),
      getFloatingTerminalCwd: () => Promise.resolve('~')
    },
    e2e: {
      getConfig: () => createE2EConfig({})
    },
    settings: {
      get: async () => getStoredSettings(),
      set: async (updates) => {
        if (updates.activeRuntimeEnvironmentId === null) {
          disconnectActiveRuntimeEnvironment()
        }
        const next = mergeSettings(getStoredSettings(), updates)
        writeJson(SETTINGS_STORAGE_KEY, next)
        return next
      },
      listFonts: () => Promise.resolve([]),
      onChanged: () => noopUnsubscribe
    } satisfies Partial<WebSettingsApi> as unknown as WebSettingsApi,
    ui: createWebUiApi(),
    session: {
      get: () => Promise.resolve(readJson(SESSION_STORAGE_KEY, getDefaultWorkspaceSession())),
      set: async (session) => {
        writeJson(SESSION_STORAGE_KEY, session)
      },
      setSync: (session) => {
        writeJson(SESSION_STORAGE_KEY, session)
      }
    },
    onboarding: {
      get: () => Promise.resolve(getStoredOnboarding()),
      update: async (updates) => {
        const current = getStoredOnboarding()
        const next: OnboardingState = {
          ...current,
          ...updates,
          checklist: {
            ...current.checklist,
            ...updates.checklist
          }
        }
        writeJson(ONBOARDING_STORAGE_KEY, next)
        return next
      }
    },
    cache: {
      getGitHub: () =>
        Promise.resolve(
          readJson(GITHUB_CACHE_STORAGE_KEY, {
            pr: {},
            issue: {}
          })
        ),
      setGitHub: async ({ cache }) => {
        writeJson(GITHUB_CACHE_STORAGE_KEY, cache)
      }
    },
    runtime: createRuntimeApi(),
    runtimeEnvironments: createRuntimeEnvironmentsApi(),
    repos: createReposApi(),
    worktrees: createWorktreesApi(),
    fs: createFileApi(),
    git: createGitApi(),
    browser: createBrowserApi(),
    gh: createGitHubApi(),
    linear: createRuntimeNamespaceApi('linear'),
    notes: createNotesApi(),
    hooks: createHooksApi(),
    stats: {
      getSummary: async () =>
        callRuntimeResult<StatsSummary>('stats.summary').catch(() => ({
          totalAgentsSpawned: 0,
          totalPRsCreated: 0,
          totalAgentTimeMs: 0,
          firstEventAt: null
        }))
    },
    memory: {
      getSnapshot: () => Promise.resolve(createEmptyMemorySnapshot())
    },
    preflight: createPreflightApi(),
    notifications: createNotificationsApi(),
    rateLimits: createRateLimitsApi(),
    codexAccounts: createAccountsApi(),
    claudeAccounts: createAccountsApi(),
    cli: createCliApi(),
    agentHooks: createAgentHooksApi(),
    developerPermissions: createDeveloperPermissionsApi(),
    computerUsePermissions: createComputerUsePermissionsApi(),
    updater: createUpdaterApi(),
    shell: createShellApi(),
    pty: createPtyApi(),
    ssh: createSshApi(),
    wsl: { isAvailable: () => Promise.resolve(false) },
    pwsh: { isAvailable: () => Promise.resolve(false) },
    agentStatus: {
      onSet: () => noopUnsubscribe,
      getSnapshot: () => Promise.resolve([]),
      drop: () => {}
    },
    mobile: {
      listNetworkInterfaces: () => Promise.resolve({ interfaces: [] }),
      getPairingQR: () => Promise.resolve({ available: false }),
      getRuntimePairingUrl: () => Promise.resolve({ available: false }),
      listDevices: () => Promise.resolve({ devices: [] }),
      revokeDevice: () => Promise.resolve({ revoked: false }),
      isWebSocketReady: () => Promise.resolve({ ready: Boolean(activeEnvironment), endpoint: null })
    },
    telemetryTrack: () => Promise.resolve(),
    telemetrySetOptIn: () => Promise.resolve(),
    telemetryGetConsentState: () =>
      Promise.resolve({ optedIn: false, source: 'default', blockedByEnv: false } as never),
    telemetryAcknowledgeBanner: () => Promise.resolve()
  }
}

function createRuntimeApi(): NonNullable<Partial<PreloadApi>['runtime']> {
  return {
    syncWindowGraph: async (_graph: RuntimeSyncWindowGraph) => getRemoteRuntimeStatus(),
    getStatus: () => getRemoteRuntimeStatus(),
    call: ({ method, params }) => callRuntimeEnvelope(method, params),
    getTerminalFitOverrides: () => Promise.resolve([]),
    restoreTerminalFit: () => Promise.resolve({ restored: false }),
    onTerminalFitOverrideChanged: () => noopUnsubscribe,
    onTerminalDriverChanged: () => noopUnsubscribe
  }
}

function createRuntimeEnvironmentsApi(): NonNullable<Partial<PreloadApi>['runtimeEnvironments']> {
  return {
    list: async () => {
      const environment = requireActiveEnvironmentOrNull()
      return environment ? [redactStoredWebRuntimeEnvironment(environment)] : []
    },
    addFromPairingCode: async ({ name, pairingCode }) => {
      const offer = parseWebPairingInput(pairingCode)
      if (!offer) {
        throw new Error('Invalid Orca pairing code.')
      }
      closeActiveRuntimeClients()
      activeEnvironment = createStoredWebRuntimeEnvironment({ name, offer })
      saveStoredWebRuntimeEnvironment(activeEnvironment)
      return { environment: redactStoredWebRuntimeEnvironment(activeEnvironment) }
    },
    resolve: async ({ selector }) =>
      redactStoredWebRuntimeEnvironment(resolveEnvironment(selector)),
    remove: async ({ selector }) => {
      const environment = resolveEnvironment(selector)
      if (activeEnvironment?.id === environment.id) {
        disconnectActiveRuntimeEnvironment()
      }
      return { removed: redactStoredWebRuntimeEnvironment(environment) }
    },
    getStatus: ({ selector, timeoutMs }) =>
      callEnvironmentEnvelope<RuntimeStatus>(selector, 'status.get', undefined, timeoutMs),
    call: ({ selector, method, params, timeoutMs }) =>
      callEnvironmentEnvelope(selector, method, params, timeoutMs),
    subscribe: async ({ selector, method, params, timeoutMs }, callbacks) => {
      const environment = resolveEnvironment(selector)
      const client = getClientForEnvironment(environment)
      return client.subscribe(method, params, callbacks, { timeoutMs })
    }
  }
}

function createReposApi(): NonNullable<Partial<PreloadApi>['repos']> {
  return {
    list: async () => (await callRuntimeResult<{ repos: Repo[] }>('repo.list')).repos,
    add: async ({ path, kind }) => callRuntimeResult('repo.add', { path, kind }),
    remove: async ({ repoId }) => {
      await callRuntimeResult('repo.rm', { repo: repoId })
      cachedWorktrees = null
    },
    reorder: async ({ orderedIds }) => callRuntimeResult('repo.reorder', { orderedIds }),
    update: async ({ repoId, updates }) =>
      (await callRuntimeResult<{ repo: Repo }>('repo.update', { repo: repoId, updates })).repo,
    pickFolder: () => Promise.resolve(null),
    pickDirectory: () => Promise.resolve(null),
    clone: async ({ url, destination }) =>
      (await callRuntimeResult<{ repo: Repo }>('repo.clone', { url, destination }, 10 * 60_000))
        .repo,
    cloneAbort: () => Promise.resolve(),
    addRemote: async ({ remotePath, displayName, kind }) => {
      const result = await callRuntimeResult<{ repo: Repo }>('repo.add', {
        path: remotePath,
        kind
      })
      return displayName
        ? {
            repo: await createReposApi().update({
              repoId: result.repo.id,
              updates: { displayName }
            })
          }
        : result
    },
    create: async ({ parentPath, name, kind }) =>
      callRuntimeResult('repo.create', { parentPath, name, kind }),
    onCloneProgress: () => noopUnsubscribe,
    getGitUsername: () => Promise.resolve(''),
    getBaseRefDefault: async ({ repoId }) =>
      callRuntimeResult('repo.baseRefDefault', { repo: repoId }),
    searchBaseRefs: async ({ repoId, query, limit }) =>
      (
        await callRuntimeResult<{ refs: string[] }>('repo.searchRefs', {
          repo: repoId,
          query,
          limit
        })
      ).refs,
    onChanged: () => noopUnsubscribe
  }
}

function createWorktreesApi(): NonNullable<Partial<PreloadApi>['worktrees']> {
  return {
    list: async ({ repoId }) =>
      (await callRuntimeResult<{ worktrees: Worktree[] }>('worktree.list', { repo: repoId }))
        .worktrees,
    listAll: () => listAllRuntimeWorktrees(),
    create: async (args) => {
      cachedWorktrees = null
      return callRuntimeResult('worktree.create', {
        repo: args.repoId,
        name: args.name,
        baseBranch: args.baseBranch,
        linkedIssue: args.linkedIssue,
        linkedPR: args.linkedPR,
        displayName: args.displayName,
        sparseCheckout: args.sparseCheckout,
        pushTarget: args.pushTarget,
        setupDecision: args.setupDecision,
        createdWithAgent: args.createdWithAgent
      })
    },
    resolvePrBase: async ({ repoId, prNumber, headRefName, isCrossRepository }) =>
      callRuntimeResult('worktree.resolvePrBase', {
        repo: repoId,
        prNumber,
        headRefName,
        isCrossRepository
      }),
    resolveMrBase: async () => ({
      error: 'GitLab merge request base resolution is unavailable on web.'
    }),
    remove: async ({ worktreeId, force }) => {
      cachedWorktrees = null
      await callRuntimeResult('worktree.rm', { worktree: worktreeId, force })
    },
    updateMeta: async ({ worktreeId, updates }) =>
      (
        await callRuntimeResult<{ worktree: Worktree }>('worktree.set', {
          worktree: worktreeId,
          ...updates
        })
      ).worktree,
    persistSortOrder: async ({ orderedIds }) => {
      await callRuntimeResult('worktree.persistSortOrder', { orderedIds })
    },
    onChanged: () => noopUnsubscribe,
    onBaseStatus: () => noopUnsubscribe,
    onRemoteBranchConflict: () => noopUnsubscribe
  }
}

function createFileApi(): NonNullable<Partial<PreloadApi>['fs']> {
  return {
    readDir: async ({ dirPath }) => {
      const file = await resolveRuntimeFilePath(dirPath)
      return callRuntimeResult<DirEntry[]>('files.readDir', {
        worktree: file.worktree.id,
        relativePath: file.relativePath
      })
    },
    readFile: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.readPreview', {
        worktree: file.worktree.id,
        relativePath: file.relativePath
      })
    },
    listMarkdownDocuments: async ({ rootPath }) => {
      const file = await resolveRuntimeFilePath(rootPath)
      return callRuntimeResult('files.listMarkdownDocuments', { worktree: file.worktree.id })
    },
    writeFile: async ({ filePath, content }) => {
      const file = await resolveRuntimeFilePath(filePath)
      await callRuntimeResult('files.write', {
        worktree: file.worktree.id,
        relativePath: file.relativePath,
        content
      })
    },
    createFile: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      await callRuntimeResult('files.createFile', {
        worktree: file.worktree.id,
        relativePath: file.relativePath
      })
    },
    createDir: async ({ dirPath }) => {
      const file = await resolveRuntimeFilePath(dirPath)
      await callRuntimeResult('files.createDir', {
        worktree: file.worktree.id,
        relativePath: file.relativePath
      })
    },
    rename: async ({ oldPath, newPath }) => {
      const oldFile = await resolveRuntimeFilePath(oldPath)
      const newFile = await resolveRuntimeFilePath(newPath)
      await callRuntimeResult('files.rename', {
        worktree: oldFile.worktree.id,
        oldRelativePath: oldFile.relativePath,
        newRelativePath: newFile.relativePath
      })
    },
    copy: async ({ sourcePath, destinationPath }) => {
      const source = await resolveRuntimeFilePath(sourcePath)
      const destination = await resolveRuntimeFilePath(destinationPath)
      await callRuntimeResult('files.copy', {
        worktree: source.worktree.id,
        sourceRelativePath: source.relativePath,
        destinationRelativePath: destination.relativePath
      })
    },
    deletePath: async ({ targetPath, recursive }) => {
      const file = await resolveRuntimeFilePath(targetPath)
      await callRuntimeResult('files.delete', {
        worktree: file.worktree.id,
        relativePath: file.relativePath,
        recursive
      })
    },
    authorizeExternalPath: () => Promise.resolve(),
    stat: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.stat', {
        worktree: file.worktree.id,
        relativePath: file.relativePath
      })
    },
    listFiles: async ({ rootPath, excludePaths }) => {
      const file = await resolveRuntimeFilePath(rootPath)
      const result = await callRuntimeResult<{ files: { relativePath: string }[] }>(
        'files.listAll',
        {
          worktree: file.worktree.id,
          excludePaths
        }
      )
      return result.files.map((entry) => entry.relativePath)
    },
    search: async (args) => {
      const file = await resolveRuntimeFilePath(args.rootPath)
      return callRuntimeResult<SearchResult>('files.search', {
        worktree: file.worktree.id,
        query: args.query,
        caseSensitive: args.caseSensitive,
        wholeWord: args.wholeWord,
        useRegex: args.useRegex,
        includePattern: args.includePattern,
        excludePattern: args.excludePattern,
        maxResults: args.maxResults
      })
    },
    importExternalPaths: async () => ({ results: [] }),
    stageExternalPathsForRuntimeUpload: async () => ({ sources: [] }),
    resolveDroppedPathsForAgent: async () => ({ resolvedPaths: [], skipped: [], failed: [] }),
    watchWorktree: () => Promise.resolve(),
    unwatchWorktree: () => Promise.resolve(),
    onFsChanged: () => noopUnsubscribe
  }
}

function createGitApi(): NonNullable<Partial<PreloadApi>['git']> {
  return {
    status: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.status', { worktree: worktree.id })
    },
    conflictOperation: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.conflictOperation', { worktree: worktree.id })
    },
    diff: async ({ worktreePath, filePath, staged, compareAgainstHead }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.diff', {
        worktree: file.worktree.id,
        filePath: file.relativePath,
        staged,
        compareAgainstHead
      })
    },
    branchCompare: async ({ worktreePath, baseRef }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.branchCompare', { worktree: worktree.id, baseRef })
    },
    upstreamStatus: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.upstreamStatus', { worktree: worktree.id })
    },
    fetch: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.fetch', { worktree: worktree.id })
    },
    push: async ({ worktreePath, publish, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.push', { worktree: worktree.id, publish, pushTarget })
    },
    pull: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.pull', { worktree: worktree.id })
    },
    branchDiff: async ({ worktreePath, filePath, compare, oldPath }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.branchDiff', {
        worktree: file.worktree.id,
        filePath: file.relativePath,
        compare,
        oldPath
      })
    },
    commit: async ({ worktreePath, message }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.commit', { worktree: worktree.id, message })
    },
    generateCommitMessage: async () => ({
      success: false,
      error: 'Commit message generation is unavailable in the web client.'
    }),
    cancelGenerateCommitMessage: () => Promise.resolve(),
    stage: async ({ worktreePath, filePath }) => mutateGitPath('git.stage', worktreePath, filePath),
    bulkStage: async ({ worktreePath, filePaths }) =>
      mutateGitPaths('git.bulkStage', worktreePath, filePaths),
    unstage: async ({ worktreePath, filePath }) =>
      mutateGitPath('git.unstage', worktreePath, filePath),
    bulkUnstage: async ({ worktreePath, filePaths }) =>
      mutateGitPaths('git.bulkUnstage', worktreePath, filePaths),
    discard: async ({ worktreePath, filePath }) =>
      mutateGitPath('git.discard', worktreePath, filePath),
    bulkDiscard: async ({ worktreePath, filePaths }) => {
      for (const filePath of filePaths) {
        await mutateGitPath('git.discard', worktreePath, filePath)
      }
    },
    remoteFileUrl: async ({ worktreePath, relativePath, line }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.remoteFileUrl', {
        worktree: worktree.id,
        relativePath,
        line
      })
    }
  }
}

function createBrowserApi(): NonNullable<Partial<PreloadApi>['browser']> {
  return {
    registerGuest: () => Promise.resolve(),
    unregisterGuest: () => Promise.resolve(),
    openDevTools: () => Promise.resolve(false),
    setViewportOverride: () => Promise.resolve(false),
    onGuestLoadFailed: () => noopUnsubscribe,
    onPermissionDenied: () => noopUnsubscribe,
    onPopup: () => noopUnsubscribe,
    onDownloadRequested: () => noopUnsubscribe,
    onDownloadProgress: () => noopUnsubscribe,
    onDownloadFinished: () => noopUnsubscribe,
    onContextMenuRequested: () => noopUnsubscribe,
    onContextMenuDismissed: () => noopUnsubscribe,
    onNavigationUpdate: () => noopUnsubscribe,
    onActivateView: () => noopUnsubscribe,
    onPaneFocus: () => noopUnsubscribe,
    onOpenLinkInOrcaTab: () => noopUnsubscribe,
    acceptDownload: () =>
      Promise.resolve({ ok: false, reason: 'Downloads are handled by the server browser.' }),
    cancelDownload: () => Promise.resolve(false),
    setGrabMode: () =>
      Promise.resolve({ ok: false, error: 'Grab mode is unavailable in the web client.' }),
    awaitGrabSelection: () =>
      Promise.resolve({ ok: false, error: 'Grab mode is unavailable in the web client.' }),
    cancelGrab: () => Promise.resolve(false),
    captureSelectionScreenshot: () =>
      Promise.resolve({
        ok: false,
        error: 'Selection screenshots are unavailable in the web client.'
      }),
    extractHoverPayload: () =>
      Promise.resolve({ ok: false, error: 'Hover extraction is unavailable in the web client.' }),
    onGrabModeToggle: () => noopUnsubscribe,
    onGrabActionShortcut: () => noopUnsubscribe,
    sessionListProfiles: () => Promise.resolve([]),
    sessionCreateProfile: () => Promise.resolve(null),
    sessionDeleteProfile: () => Promise.resolve(false),
    sessionImportCookies: () =>
      Promise.resolve({
        ok: false,
        summary: null,
        error: 'Cookie import is unavailable in the web client.'
      }),
    sessionResolvePartition: () => Promise.resolve(null),
    sessionDetectBrowsers: () => Promise.resolve([]),
    sessionImportFromBrowser: () =>
      Promise.resolve({
        ok: false,
        summary: null,
        error: 'Cookie import is unavailable in the web client.'
      }),
    sessionClearDefaultCookies: () => Promise.resolve(false),
    notifyActiveTabChanged: () => Promise.resolve(false)
  } as unknown as NonNullable<Partial<PreloadApi>['browser']>
}

function createGitHubApi(): NonNullable<Partial<PreloadApi>['gh']> {
  const direct = (method: string) => (args?: unknown) =>
    callRuntimeResult(method, mapRepoPathArg(args))
  return {
    viewer: () => Promise.resolve(null),
    repoSlug: direct('github.repoSlug'),
    prForBranch: direct('github.prForBranch'),
    issue: direct('github.issue'),
    workItem: direct('github.workItem'),
    workItemByOwnerRepo: direct('github.workItemByOwnerRepo'),
    workItemDetails: direct('github.workItemDetails'),
    prFileContents: direct('github.prFileContents'),
    listIssues: async () => [],
    createIssue: direct('github.createIssue'),
    countWorkItems: direct('github.countWorkItems'),
    listWorkItems: direct('github.listWorkItems'),
    prChecks: direct('github.prChecks'),
    prComments: direct('github.prComments'),
    resolveReviewThread: direct('github.resolveReviewThread'),
    updatePRTitle: direct('github.updatePRTitle'),
    mergePR: direct('github.mergePR'),
    updateIssue: direct('github.updateIssue'),
    addIssueComment: direct('github.addIssueComment'),
    addPRReviewCommentReply: direct('github.addPRReviewCommentReply'),
    addPRReviewComment: direct('github.addPRReviewComment'),
    listLabels: direct('github.listLabels'),
    listAssignableUsers: direct('github.listAssignableUsers'),
    onWorkItemMutated: () => noopUnsubscribe,
    checkOrcaStarred: () => Promise.resolve(null),
    starOrca: () => Promise.resolve(false),
    rateLimit: direct('github.rateLimit'),
    diagnoseAuth: () =>
      Promise.resolve({ ok: false, message: 'Unavailable in the web client.' } as never),
    listAccessibleProjects: direct('github.project.listAccessible'),
    resolveProjectRef: direct('github.project.resolveRef'),
    listProjectViews: direct('github.project.listViews'),
    getProjectViewTable: direct('github.project.viewTable'),
    projectWorkItemDetailsBySlug: direct('github.project.workItemDetailsBySlug'),
    updateProjectItemField: direct('github.project.updateItemField'),
    clearProjectItemField: direct('github.project.clearItemField'),
    updateIssueBySlug: direct('github.project.updateIssueBySlug'),
    updatePullRequestBySlug: direct('github.project.updatePullRequestBySlug'),
    addIssueCommentBySlug: direct('github.project.addIssueCommentBySlug'),
    updateIssueCommentBySlug: direct('github.project.updateIssueCommentBySlug'),
    deleteIssueCommentBySlug: direct('github.project.deleteIssueCommentBySlug'),
    listLabelsBySlug: direct('github.project.listLabelsBySlug'),
    listAssignableUsersBySlug: direct('github.project.listAssignableUsersBySlug'),
    listIssueTypesBySlug: direct('github.project.listIssueTypesBySlug'),
    updateIssueTypeBySlug: direct('github.project.updateIssueTypeBySlug')
  } as NonNullable<Partial<PreloadApi>['gh']>
}

function createRuntimeNamespaceApi(prefix: string): never {
  return createFallbackProxy([prefix], (path, args) => {
    const method = `${prefix}.${path.at(-1) ?? ''}`
    return callRuntimeResult(method, args[0])
  }) as never
}

function createNotesApi(): NonNullable<Partial<PreloadApi>['notes']> {
  const noteCall = (method: string) => (args: Record<string, unknown>) =>
    callRuntimeResult(method, { ...args, worktree: args.worktreeId })
  return {
    list: noteCall('note.list'),
    show: noteCall('note.show'),
    create: noteCall('note.create'),
    save: noteCall('note.save'),
    rename: noteCall('note.rename'),
    delete: noteCall('note.delete'),
    append: noteCall('note.append'),
    search: noteCall('note.search'),
    link: noteCall('note.link'),
    panelState: noteCall('note.panelState')
  } as NonNullable<Partial<PreloadApi>['notes']>
}

function createHooksApi(): NonNullable<Partial<PreloadApi>['hooks']> {
  return {
    check: async ({ repoId }) => callRuntimeResult('repo.hooksCheck', { repo: repoId }),
    createIssueCommandRunner: async () => ({ launched: false }) as never,
    readIssueCommand: async ({ repoId }) =>
      callRuntimeResult('repo.issueCommandRead', { repo: repoId }),
    writeIssueCommand: async ({ repoId, content }) => {
      await callRuntimeResult('repo.issueCommandWrite', { repo: repoId, content })
    }
  }
}

function createWebUiApi(): NonNullable<Partial<PreloadApi>['ui']> {
  let zoomLevel = readJson(UI_STORAGE_KEY, getDefaultUIState()).uiZoomLevel
  return {
    get: () => Promise.resolve(readJson(UI_STORAGE_KEY, getDefaultUIState())),
    set: async (updates) => {
      const next = { ...readJson(UI_STORAGE_KEY, getDefaultUIState()), ...updates }
      writeJson(UI_STORAGE_KEY, next)
    },
    readClipboardText: () => navigator.clipboard?.readText?.() ?? Promise.resolve(''),
    saveClipboardImageAsTempFile: () => Promise.resolve(null),
    writeClipboardText: (text) => navigator.clipboard?.writeText?.(text) ?? Promise.resolve(),
    writeClipboardImage: () => Promise.resolve(),
    getZoomLevel: () => zoomLevel,
    setZoomLevel: (level) => {
      zoomLevel = level
    },
    isMaximized: () => Promise.resolve(false),
    onOpenSettings: () => noopUnsubscribe,
    onOpenFeatureTour: () => noopUnsubscribe,
    onShowFeatureTourNudge: () => noopUnsubscribe,
    onToggleLeftSidebar: () => noopUnsubscribe,
    onToggleRightSidebar: () => noopUnsubscribe,
    onToggleWorktreePalette: () => noopUnsubscribe,
    onToggleFloatingTerminal: () => noopUnsubscribe,
    onOpenQuickOpen: () => noopUnsubscribe,
    onOpenNewWorkspace: () => noopUnsubscribe,
    onJumpToWorktreeIndex: () => noopUnsubscribe,
    onWorktreeHistoryNavigate: () => noopUnsubscribe,
    onNewBrowserTab: () => noopUnsubscribe,
    onRequestTabCreate: () => noopUnsubscribe,
    replyTabCreate: () => {},
    onRequestTabSetProfile: () => noopUnsubscribe,
    replyTabSetProfile: () => {},
    onRequestTabClose: () => noopUnsubscribe,
    replyTabClose: () => {},
    onNewTerminalTab: () => noopUnsubscribe,
    onFocusBrowserAddressBar: () => noopUnsubscribe,
    onFindInBrowserPage: () => noopUnsubscribe,
    onReloadBrowserPage: () => noopUnsubscribe,
    onHardReloadBrowserPage: () => noopUnsubscribe,
    onCloseActiveTab: () => noopUnsubscribe,
    onSwitchTab: () => noopUnsubscribe,
    onSwitchTabAcrossAllTypes: () => noopUnsubscribe,
    onSwitchTerminalTab: () => noopUnsubscribe,
    onToggleStatusBar: () => noopUnsubscribe,
    onDictationKeyDown: () => noopUnsubscribe,
    onExportPdfRequested: () => noopUnsubscribe,
    onActivateWorktree: () => noopUnsubscribe,
    onCreateTerminal: () => noopUnsubscribe,
    onRequestTerminalCreate: () => noopUnsubscribe,
    replyTerminalCreate: () => {},
    onSplitTerminal: () => noopUnsubscribe,
    onRenameTerminal: () => noopUnsubscribe,
    onFocusTerminal: () => noopUnsubscribe,
    onFocusEditorTab: () => noopUnsubscribe,
    onCloseSessionTab: () => noopUnsubscribe,
    onOpenFileFromMobile: () => noopUnsubscribe,
    onMobileMarkdownRequest: () => noopUnsubscribe,
    respondMobileMarkdownRequest: () => {},
    onCloseTerminal: () => noopUnsubscribe,
    onSleepWorktree: () => noopUnsubscribe,
    onTerminalZoom: () => noopUnsubscribe,
    onFileDrop: () => noopUnsubscribe,
    syncTrafficLights: () => {},
    setMarkdownEditorFocused: () => {},
    onRichMarkdownContextCommand: () => noopUnsubscribe,
    onFullscreenChanged: () => noopUnsubscribe,
    minimize: () => {},
    maximize: () => {},
    onMaximizeChanged: () => noopUnsubscribe,
    requestClose: () => {},
    popupMenu: () => {},
    onWindowCloseRequested: () => noopUnsubscribe,
    confirmWindowClose: () => {}
  }
}

function createPreflightApi(): NonNullable<Partial<PreloadApi>['preflight']> {
  const fallbackStatus: PreflightStatus = {
    git: { installed: false },
    gh: { installed: false, authenticated: false },
    glab: { installed: false, authenticated: false },
    bitbucket: { configured: false, authenticated: false, account: null }
  }
  const fallbackRefreshAgents: RefreshAgentsResult = {
    agents: [],
    addedPathSegments: [],
    shellHydrationOk: false,
    pathSource: 'sync_seed_only',
    pathFailureReason: 'spawn_error'
  }
  return {
    check: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return fallbackStatus
      }
      return callRuntimeResult<PreflightStatus>('preflight.check', args)
    },
    detectAgents: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return []
      }
      return callRuntimeResult<string[]>('preflight.detectAgents').catch(() => [])
    },
    refreshAgents: () =>
      requireActiveEnvironmentOrNull()
        ? callRuntimeResult('preflight.refreshAgents')
            .then((result) => result as RefreshAgentsResult)
            .catch(() => fallbackRefreshAgents)
        : Promise.resolve(fallbackRefreshAgents),
    detectRemoteAgents: async (args) =>
      requireActiveEnvironmentOrNull()
        ? callRuntimeResult<string[]>('preflight.detectRemoteAgents', args).catch(() => [])
        : []
  }
}

function createCliApi(): NonNullable<Partial<PreloadApi>['cli']> {
  const status = {
    platform: getBrowserPlatform(),
    commandName: 'orca',
    commandPath: null,
    pathDirectory: null,
    pathConfigured: false,
    launcherPath: null,
    installMethod: null,
    supported: false,
    state: 'unsupported',
    currentTarget: null,
    unsupportedReason: 'launch_mode_unavailable',
    detail: 'CLI registration is managed on the Orca server, not in the web browser.'
  } as const
  return {
    getInstallStatus: () => Promise.resolve(status),
    install: () => Promise.resolve(status),
    remove: () => Promise.resolve(status)
  } as NonNullable<Partial<PreloadApi>['cli']>
}

function createAgentHooksApi(): NonNullable<Partial<PreloadApi>['agentHooks']> {
  const status = (agent: 'claude' | 'codex' | 'gemini' | 'cursor' | 'droid') =>
    Promise.resolve({
      agent,
      state: 'not_installed',
      configPath: '',
      managedHooksPresent: false,
      detail: 'Agent hook status is only available on the Orca server.'
    } as const)
  return {
    claudeStatus: () => status('claude'),
    codexStatus: () => status('codex'),
    geminiStatus: () => status('gemini'),
    cursorStatus: () => status('cursor'),
    droidStatus: () => status('droid')
  }
}

function createDeveloperPermissionsApi(): NonNullable<Partial<PreloadApi>['developerPermissions']> {
  return {
    getStatus: () => Promise.resolve([]),
    request: ({ id }) =>
      Promise.resolve({ id, status: 'unsupported', openedSystemSettings: false } as const),
    openSettings: () => Promise.resolve()
  }
}

function createComputerUsePermissionsApi(): NonNullable<
  Partial<PreloadApi>['computerUsePermissions']
> {
  return {
    getStatus: () =>
      Promise.resolve({
        platform: getBrowserPlatform(),
        helperAppPath: null,
        helperUnavailableReason: 'web_client',
        permissions: []
      }),
    openSetup: () =>
      Promise.resolve({
        platform: getBrowserPlatform(),
        helperAppPath: null,
        openedSettings: false,
        launchedHelper: false,
        nextStep: 'Computer-use permissions are managed on the Orca server.'
      })
  }
}

function createNotificationsApi(): NonNullable<Partial<PreloadApi>['notifications']> {
  return {
    dispatch: () => Promise.resolve({ delivered: false, reason: 'not-supported' }),
    openSystemSettings: () => Promise.resolve(),
    getPermissionStatus: () =>
      Promise.resolve({ supported: false, platform: getBrowserPlatform(), requested: false }),
    requestPermission: () =>
      Promise.resolve({ supported: false, platform: getBrowserPlatform(), requested: false }),
    playSound: () => Promise.resolve({ played: false, reason: 'missing-path' })
  }
}

function createRateLimitsApi(): NonNullable<Partial<PreloadApi>['rateLimits']> {
  const empty: RateLimitState = {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
  return {
    get: () => Promise.resolve(empty),
    refresh: () => Promise.resolve(empty),
    setPollingInterval: () => Promise.resolve(),
    fetchInactiveClaudeAccounts: () => Promise.resolve(),
    fetchInactiveCodexAccounts: () => Promise.resolve(),
    onUpdate: () => noopUnsubscribe
  }
}

function createAccountsApi(): never {
  const empty = { accounts: [], activeAccountId: null }
  return {
    list: () => Promise.resolve(empty),
    add: () => Promise.resolve(empty),
    reauthenticate: () => Promise.resolve(empty),
    remove: () => Promise.resolve(empty),
    select: () => Promise.resolve(empty)
  } as never
}

function createUpdaterApi(): NonNullable<Partial<PreloadApi>['updater']> {
  return {
    getVersion: () => Promise.resolve('web'),
    getStatus: () => Promise.resolve({ state: 'idle' } as never),
    check: () => Promise.resolve(),
    download: () => Promise.resolve(),
    quitAndInstall: () => Promise.resolve(),
    dismissNudge: () => Promise.resolve(),
    onStatus: () => noopUnsubscribe,
    onClearDismissal: () => noopUnsubscribe
  }
}

function createShellApi(): NonNullable<Partial<PreloadApi>['shell']> {
  const openResult = { ok: true } as const
  return {
    openPath: (path) =>
      Promise.resolve(window.open(path, '_blank', 'noopener,noreferrer') as never),
    openInFileManager: () => Promise.resolve(openResult),
    openInExternalEditor: () => Promise.resolve(openResult),
    openUrl: (url) => Promise.resolve(window.open(url, '_blank', 'noopener,noreferrer') as never),
    openFilePath: () => Promise.resolve(),
    openFileUri: (uri) =>
      Promise.resolve(window.open(uri, '_blank', 'noopener,noreferrer') as never),
    pathExists: async (path) => {
      try {
        await resolveRuntimeFilePath(path)
        return true
      } catch {
        return false
      }
    },
    pickAttachment: () => Promise.resolve(null),
    pickImage: () => Promise.resolve(null),
    pickAudio: () => Promise.resolve(null),
    pickDirectory: () => Promise.resolve(null),
    copyFile: () => Promise.resolve()
  }
}

function createPtyApi(): NonNullable<Partial<PreloadApi>['pty']> {
  return {
    spawn: () => Promise.reject(new Error('Local PTYs are unavailable in the web client.')),
    write: () => {},
    resize: () => {},
    reportGeometry: () => {},
    signal: () => {},
    kill: () => Promise.resolve(),
    ackColdRestore: () => {},
    hasChildProcesses: () => Promise.resolve(false),
    getForegroundProcess: () => Promise.resolve(null),
    getCwd: () => Promise.resolve('~'),
    listSessions: () => Promise.resolve([]),
    onData: () => noopUnsubscribe,
    onReplay: () => noopUnsubscribe,
    onExit: () => noopUnsubscribe,
    onSerializeBufferRequest: () => noopUnsubscribe,
    onClearBufferRequest: () => noopUnsubscribe,
    sendSerializedBuffer: () => {},
    declarePendingPaneSerializer: () => Promise.resolve(0),
    settlePaneSerializer: () => Promise.resolve(),
    clearPendingPaneSerializer: () => Promise.resolve(),
    management: {
      listSessions: () => Promise.resolve({ sessions: [] }),
      killAll: () => Promise.resolve({ killedCount: 0, remainingCount: 0 }),
      killOne: () => Promise.resolve({ success: false }),
      restart: () => Promise.resolve({ success: false })
    }
  }
}

function createSshApi(): NonNullable<Partial<PreloadApi>['ssh']> {
  return {
    listTargets: () => Promise.resolve([]),
    addTarget: () =>
      Promise.reject(new Error('SSH target management is unavailable in the web client.')),
    updateTarget: () =>
      Promise.reject(new Error('SSH target management is unavailable in the web client.')),
    removeTarget: () => Promise.resolve(),
    importConfig: () => Promise.resolve([]),
    connect: () => Promise.resolve(null),
    disconnect: () => Promise.resolve(),
    terminateSessions: () => Promise.resolve(),
    getState: () => Promise.resolve(null),
    needsPassphrasePrompt: () => Promise.resolve(false),
    testConnection: () =>
      Promise.resolve({ success: false, error: 'Unavailable in the web client.' }),
    onStateChanged: () => noopUnsubscribe,
    addPortForward: () =>
      Promise.reject(new Error('SSH port forwarding is unavailable in the web client.')),
    updatePortForward: () =>
      Promise.reject(new Error('SSH port forwarding is unavailable in the web client.')),
    removePortForward: () => Promise.resolve(null),
    listPortForwards: () => Promise.resolve([]),
    listDetectedPorts: () => Promise.resolve([]),
    onPortForwardsChanged: () => noopUnsubscribe,
    onDetectedPortsChanged: () => noopUnsubscribe,
    browseDir: () => Promise.resolve({ entries: [], resolvedPath: '' }),
    onCredentialRequest: () => noopUnsubscribe,
    onCredentialResolved: () => noopUnsubscribe,
    submitCredential: () => Promise.resolve()
  }
}

async function callRuntimeEnvelope<TResult = unknown>(
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<RuntimeRpcResponse<TResult>> {
  const environment = requireActiveEnvironment()
  const response = await getClientForEnvironment(environment).call(method, params, { timeoutMs })
  updateEnvironmentFromResponse(environment, response)
  return response as RuntimeRpcResponse<TResult>
}

async function callEnvironmentEnvelope<TResult = unknown>(
  selector: string,
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<RuntimeRpcResponse<TResult>> {
  const environment = resolveEnvironment(selector)
  const response = await getClientForEnvironment(environment).call(method, params, { timeoutMs })
  updateEnvironmentFromResponse(environment, response)
  return response as RuntimeRpcResponse<TResult>
}

async function callRuntimeResult<TResult>(
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<TResult> {
  const response = await callRuntimeEnvelope(method, params, timeoutMs)
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as TResult
}

async function getRemoteRuntimeStatus(): Promise<RuntimeStatus> {
  return callRuntimeResult<RuntimeStatus>('status.get', undefined, 15_000)
}

function getClientForEnvironment(environment: StoredWebRuntimeEnvironment): WebRuntimeClient {
  if (!activeClient || activeClientEnvironmentId !== environment.id) {
    activeClient?.close()
    activeClient = new WebRuntimeClient(getPreferredWebPairingOffer(environment))
    activeClientEnvironmentId = environment.id
  }
  return activeClient
}

function closeActiveRuntimeClients(): void {
  activeClient?.close()
  activeClient = null
  activeClientEnvironmentId = null
  cachedWorktrees = null
}

function disconnectActiveRuntimeEnvironment(): void {
  closeActiveRuntimeClients()
  clearStoredWebRuntimeEnvironment()
  activeEnvironment = null
}

function resolveEnvironment(selector: string): StoredWebRuntimeEnvironment {
  const environment = requireActiveEnvironment()
  if (selector === environment.id || selector === environment.name || selector === 'active') {
    return environment
  }
  throw new Error(`Unknown Orca runtime environment: ${selector}`)
}

function requireActiveEnvironment(): StoredWebRuntimeEnvironment {
  activeEnvironment = activeEnvironment ?? readStoredWebRuntimeEnvironment()
  if (!activeEnvironment) {
    throw new Error('Pair this web client with an Orca server first.')
  }
  return activeEnvironment
}

function requireActiveEnvironmentOrNull(): StoredWebRuntimeEnvironment | null {
  activeEnvironment = activeEnvironment ?? readStoredWebRuntimeEnvironment()
  return activeEnvironment
}

function updateEnvironmentFromResponse(
  environment: StoredWebRuntimeEnvironment,
  response: RuntimeRpcResponse<unknown>
): void {
  const runtimeId = response.ok ? response._meta.runtimeId : (response._meta?.runtimeId ?? null)
  activeEnvironment = updateStoredEnvironmentRuntimeId(environment, runtimeId)
}

function getStoredSettings(): GlobalSettings {
  const environment = (activeEnvironment = activeEnvironment ?? readStoredWebRuntimeEnvironment())
  const defaults = getDefaultSettings('~')
  const stored = readJson<Partial<GlobalSettings>>(SETTINGS_STORAGE_KEY, {})
  return mergeSettings(
    {
      ...defaults,
      floatingTerminalEnabled: false,
      rightSidebarOpenByDefault: false,
      activeRuntimeEnvironmentId: environment?.id ?? null
    },
    stored
  )
}

function getStoredOnboarding(): OnboardingState {
  const storedRaw = window.localStorage.getItem(ONBOARDING_STORAGE_KEY)
  if (storedRaw) {
    const stored = readJson(ONBOARDING_STORAGE_KEY, getDefaultOnboardingState())
    if (stored.checklist.dismissed) {
      return stored
    }
    const closed = closeWebOnboarding(stored)
    writeJson(ONBOARDING_STORAGE_KEY, closed)
    return closed
  }
  const closed = closeWebOnboarding(getDefaultOnboardingState())
  // Why: pairing already means the user has an Orca server. Desktop first-run
  // onboarding would incorrectly probe browser-local tools and block the client.
  writeJson(ONBOARDING_STORAGE_KEY, closed)
  return closed
}

function closeWebOnboarding(base: OnboardingState): OnboardingState {
  return {
    ...base,
    closedAt: Date.now(),
    outcome: 'dismissed',
    checklist: {
      ...base.checklist,
      dismissed: true
    }
  }
}

function mergeSettings(base: GlobalSettings, updates: Partial<GlobalSettings>): GlobalSettings {
  const defaults = getDefaultSettings('~')
  return {
    ...base,
    ...updates,
    notifications: {
      ...base.notifications,
      ...updates.notifications
    },
    githubProjects: {
      ...(base.githubProjects ?? defaults.githubProjects),
      ...updates.githubProjects
    } as GlobalSettings['githubProjects'],
    voice: {
      ...(base.voice ?? defaults.voice),
      ...updates.voice
    } as NonNullable<GlobalSettings['voice']>,
    activeRuntimeEnvironmentId: activeEnvironment?.id ?? updates.activeRuntimeEnvironmentId ?? null
  }
}

async function listAllRuntimeWorktrees(): Promise<Worktree[]> {
  if (cachedWorktrees && Date.now() - cachedWorktrees.loadedAt < 5_000) {
    return cachedWorktrees.worktrees
  }
  const result = await callRuntimeResult<{ worktrees: Worktree[] }>('worktree.list', {})
  cachedWorktrees = { loadedAt: Date.now(), worktrees: result.worktrees }
  return result.worktrees
}

async function resolveRuntimeWorktreeByPath(worktreePath: string): Promise<Worktree> {
  const worktrees = await listAllRuntimeWorktrees()
  const match = worktrees
    .map((worktree) => ({
      worktree,
      relativePath: relativePathInsideRoot(worktree.path, worktreePath)
    }))
    .filter((entry) => entry.relativePath !== null)
    .sort((a, b) => b.worktree.path.length - a.worktree.path.length)[0]
  if (!match) {
    throw new Error(`No runtime worktree owns ${worktreePath}`)
  }
  return match.worktree
}

async function resolveRuntimeFilePath(
  filePath: string,
  preferredWorktreePath?: string
): Promise<{ worktree: Worktree; relativePath: string }> {
  const worktree = preferredWorktreePath
    ? await resolveRuntimeWorktreeByPath(preferredWorktreePath)
    : await resolveRuntimeWorktreeByPath(filePath)
  const relativePath = relativePathInsideRoot(worktree.path, filePath)
  if (relativePath === null) {
    throw new Error(`File is outside runtime worktree: ${filePath}`)
  }
  return { worktree, relativePath }
}

async function mutateGitPath(
  method: string,
  worktreePath: string,
  filePath: string
): Promise<void> {
  const file = await resolveRuntimeFilePath(filePath, worktreePath)
  await callRuntimeResult(method, { worktree: file.worktree.id, filePath: file.relativePath })
}

async function mutateGitPaths(
  method: string,
  worktreePath: string,
  filePaths: string[]
): Promise<void> {
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  await callRuntimeResult(method, { worktree: worktree.id, filePaths })
}

function mapRepoPathArg(args: unknown): unknown {
  if (!args || typeof args !== 'object' || !('repoPath' in args)) {
    return args
  }
  const record = args as Record<string, unknown>
  return {
    ...record,
    repo: record.repoPath
  }
}

function createEmptyMemorySnapshot(): MemorySnapshot {
  const emptyUsage = { cpu: 0, memory: 0 }
  return {
    app: { ...emptyUsage, main: emptyUsage, renderer: emptyUsage, other: emptyUsage, history: [] },
    worktrees: [],
    host: {
      totalMemory: 0,
      freeMemory: 0,
      usedMemory: 0,
      memoryUsagePercent: 0,
      cpuCoreCount: navigator.hardwareConcurrency || 1,
      loadAverage1m: 0
    },
    totalCpu: 0,
    totalMemory: 0,
    collectedAt: Date.now()
  }
}

function getBrowserPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Windows')) {
    return 'win32'
  }
  if (navigator.userAgent.includes('Linux')) {
    return 'linux'
  }
  return 'darwin'
}

function readJson<T>(key: string, fallback: T): T {
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return cloneJson(fallback)
  }
  try {
    return { ...cloneJson(fallback), ...JSON.parse(raw) } as T
  } catch {
    return cloneJson(fallback)
  }
}

function writeJson<T>(key: string, value: T): void {
  window.localStorage.setItem(key, JSON.stringify(value))
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function withFallback<T extends object>(target: T, path: string[]): T {
  return new Proxy(target, {
    get(current, property, receiver) {
      if (property in current) {
        const value = Reflect.get(current, property, receiver) as unknown
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return withFallback(value as object, [...path, String(property)])
        }
        return value
      }
      return createFallbackProxy([...path, String(property)])
    }
  })
}

function createFallbackProxy(
  path: string[],
  applyOverride?: (path: string[], args: unknown[]) => unknown
): never {
  const fn = () => undefined
  return new Proxy(fn, {
    get(_target, property) {
      if (property === 'then') {
        return undefined
      }
      return createFallbackProxy([...path, String(property)], applyOverride)
    },
    apply(_target, _thisArg, args) {
      if (applyOverride) {
        return applyOverride(path, args)
      }
      return getFallbackResult(path, args)
    }
  }) as never
}

function getFallbackResult(path: string[], args: unknown[]): unknown {
  const name = path.at(-1) ?? ''
  if (name.startsWith('on')) {
    return noopUnsubscribe
  }
  if (name.startsWith('is') || name.startsWith('has') || name === 'pathExists') {
    return Promise.resolve(false)
  }
  if (name.startsWith('list') || name.startsWith('detect')) {
    return Promise.resolve([])
  }
  if (name.startsWith('preview')) {
    return Promise.resolve({ found: false, diff: {}, unsupportedKeys: [] })
  }
  if (name.startsWith('get') && name.endsWith('Status')) {
    return Promise.resolve([])
  }
  if (name === 'write' || name === 'resize' || name === 'reportGeometry') {
    return undefined
  }
  if (args.length === 0 && (name === 'getZoomLevel' || name === 'declarePendingPaneSerializer')) {
    return 0
  }
  return Promise.resolve(undefined)
}

function noopUnsubscribe(): void {}
