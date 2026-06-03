/* eslint-disable max-lines -- Why: the web preload adapter is the browser-side
   replacement for Electron preload, so the compatibility surface is necessarily
   centralized at this boundary. */
import type { PreloadApi, PreflightStatus, RefreshAgentsResult } from '../../../preload/api-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../../../shared/computer-use-permissions-types'
import type {
  DetectedWorktreeListResult,
  DirEntry,
  ForceDeleteWorktreeBranchResult,
  GlobalSettings,
  MemorySnapshot,
  OnboardingState,
  PersistedUIState,
  Repo,
  RemoveWorktreeResult,
  SearchResult,
  StatsSummary,
  Worktree,
  WorktreeLineage,
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/types'
import type { SkillDiscoveryResult } from '../../../shared/skills'
import {
  getDefaultOnboardingState,
  getDefaultSettings,
  getDefaultUIState,
  getDefaultWorkspaceSession,
  normalizeAgentActivityDisplayMode,
  ONBOARDING_FLOW_VERSION
} from '../../../shared/constants'
import { legacyBaseRefSearchResult } from '../../../shared/base-ref-search-result'
import { createE2EConfig } from '../../../shared/e2e-config'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import { normalizeDisabledTuiAgents } from '../../../shared/tui-agent-selection'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import {
  findKeybindingConflicts,
  formatKeybindingList,
  getKeybindingPlatform,
  isKeybindingActionId,
  normalizeKeybindingArrayForAction,
  type KeybindingActionId,
  type KeybindingFileDiagnostic,
  type KeybindingFileSnapshot,
  type KeybindingOverrides,
  type KeybindingPlatform
} from '../../../shared/keybindings'
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
import { RuntimeRpcCallQueuePool } from '../../../shared/runtime-rpc-call-queue'
import { sanitizeWebRuntimeWorkspaceSession } from './web-workspace-session'
import {
  normalizeFeatureInteractions,
  type FeatureInteractionId,
  type FeatureInteractionState
} from '../../../shared/feature-interactions'
import { normalizeContextualTourIds, type ContextualTourId } from '../../../shared/contextual-tours'

const SETTINGS_STORAGE_KEY = 'orca.web.settings.v1'
const UI_STORAGE_KEY = 'orca.web.ui.v1'
const SESSION_STORAGE_KEY = 'orca.web.workspaceSession.v1'
const ONBOARDING_STORAGE_KEY = 'orca.web.onboarding.v1'
const GITHUB_CACHE_STORAGE_KEY = 'orca.web.githubCache.v1'
const KEYBINDINGS_STORAGE_KEY = 'orca.web.keybindings.v1'
// Why: browser-paired clients need desktop parity for large dev sessions; the
// runtime's no-limit default remains capped for lower-level RPC callers.
const WEB_RUNTIME_WORKTREE_LIST_LIMIT = 10_000
const MAX_CLIPBOARD_IMAGE_BASE64_CHARS = 24 * 1024 * 1024
export const CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
export const CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS = 256 * 1024
const CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS = 30_000

let activeEnvironment: StoredWebRuntimeEnvironment | null = readStoredWebRuntimeEnvironment()
let activeClient: WebRuntimeClient | null = null
let activeClientEnvironmentId: string | null = null
let cachedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null = null
let cachedDetectedWorktrees: { loadedAt: number; worktrees: Worktree[] } | null = null
const runtimeCallQueuePool = new RuntimeRpcCallQueuePool()

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      const commaIndex = result.indexOf(',')
      resolve(commaIndex === -1 ? result : result.slice(commaIndex + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read clipboard image'))
    reader.readAsDataURL(blob)
  })
}

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')
    if (!context || canvas.width <= 0 || canvas.height <= 0) {
      throw new Error('Clipboard image could not be decoded')
    }
    context.drawImage(bitmap, 0, 0)
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => {
        if (!png) {
          reject(new Error('Clipboard image could not be encoded as PNG'))
          return
        }
        resolve(png)
      }, 'image/png')
    })
  } finally {
    bitmap.close()
  }
}

async function readClipboardImagePngBase64(): Promise<string | null> {
  const clipboard = navigator.clipboard as
    | (Clipboard & { read?: () => Promise<ClipboardItem[]> })
    | undefined
  if (!clipboard?.read) {
    return null
  }
  const items = await clipboard.read()
  for (const item of items) {
    const imageType = item.types.find((type) => type.startsWith('image/'))
    if (!imageType) {
      continue
    }
    const blob = await item.getType(imageType)
    const pngBlob = imageType === 'image/png' ? blob : await convertImageBlobToPng(blob)
    return blobToBase64(pngBlob)
  }
  return null
}

function invalidateRuntimeWorktreeCaches(): void {
  cachedWorktrees = null
  cachedDetectedWorktrees = null
}

type WebSettingsApi = NonNullable<PreloadApi['settings']>
type WebKeybindingsApi = NonNullable<PreloadApi['keybindings']>
type WebGitHubApi = NonNullable<PreloadApi['gh']>
type WebGitHubResult<K extends keyof WebGitHubApi> = Awaited<ReturnType<WebGitHubApi[K]>>
type WebGitHubRouteKey =
  | 'repoSlug'
  | 'prForBranch'
  | 'issue'
  | 'workItem'
  | 'workItemByOwnerRepo'
  | 'workItemDetails'
  | 'prFileContents'
  | 'listIssues'
  | 'createIssue'
  | 'countWorkItems'
  | 'listWorkItems'
  | 'prChecks'
  | 'prCheckDetails'
  | 'rerunPRChecks'
  | 'prComments'
  | 'resolveReviewThread'
  | 'setPRFileViewed'
  | 'updatePRTitle'
  | 'mergePR'
  | 'setPRAutoMerge'
  | 'updatePRState'
  | 'requestPRReviewers'
  | 'removePRReviewers'
  | 'updateIssue'
  | 'addIssueComment'
  | 'addPRReviewCommentReply'
  | 'addPRReviewComment'
  | 'listLabels'
  | 'listAssignableUsers'
  | 'rateLimit'
  | 'listAccessibleProjects'
  | 'resolveProjectRef'
  | 'listProjectViews'
  | 'getProjectViewTable'
  | 'projectWorkItemDetailsBySlug'
  | 'updateProjectItemField'
  | 'clearProjectItemField'
  | 'updateIssueBySlug'
  | 'updatePullRequestBySlug'
  | 'addIssueCommentBySlug'
  | 'updateIssueCommentBySlug'
  | 'deleteIssueCommentBySlug'
  | 'listLabelsBySlug'
  | 'listAssignableUsersBySlug'
  | 'listIssueTypesBySlug'
  | 'updateIssueTypeBySlug'
type WebGitHubRuntimeMethod =
  | 'github.repoSlug'
  | 'github.prForBranch'
  | 'github.issue'
  | 'github.workItem'
  | 'github.workItemByOwnerRepo'
  | 'github.workItemDetails'
  | 'github.prFileContents'
  | 'github.listIssues'
  | 'github.createIssue'
  | 'github.countWorkItems'
  | 'github.listWorkItems'
  | 'github.prChecks'
  | 'github.prCheckDetails'
  | 'github.rerunPRChecks'
  | 'github.prComments'
  | 'github.resolveReviewThread'
  | 'github.setPRFileViewed'
  | 'github.updatePRTitle'
  | 'github.mergePR'
  | 'github.setPRAutoMerge'
  | 'github.updatePRState'
  | 'github.requestPRReviewers'
  | 'github.removePRReviewers'
  | 'github.updateIssue'
  | 'github.addIssueComment'
  | 'github.addPRReviewCommentReply'
  | 'github.addPRReviewComment'
  | 'github.listLabels'
  | 'github.listAssignableUsers'
  | 'github.rateLimit'
  | 'github.project.listAccessible'
  | 'github.project.resolveRef'
  | 'github.project.listViews'
  | 'github.project.viewTable'
  | 'github.project.workItemDetailsBySlug'
  | 'github.project.updateItemField'
  | 'github.project.clearItemField'
  | 'github.project.updateIssueBySlug'
  | 'github.project.updatePullRequestBySlug'
  | 'github.project.addIssueCommentBySlug'
  | 'github.project.updateIssueCommentBySlug'
  | 'github.project.deleteIssueCommentBySlug'
  | 'github.project.listLabelsBySlug'
  | 'github.project.listAssignableUsersBySlug'
  | 'github.project.listIssueTypesBySlug'
  | 'github.project.updateIssueTypeBySlug'
type WebGitLabApi = NonNullable<PreloadApi['gl']>
type WebGitLabResult<K extends keyof WebGitLabApi> = Awaited<ReturnType<WebGitLabApi[K]>>
type WebGitLabRouteKey =
  | 'diagnoseAuth'
  | 'rateLimit'
  | 'listMRs'
  | 'listWorkItems'
  | 'listIssues'
  | 'createIssue'
  | 'updateIssue'
  | 'addIssueComment'
  | 'listLabels'
  | 'todos'
  | 'workItemDetails'
  | 'closeMR'
  | 'reopenMR'
  | 'mergeMR'
  | 'updateMR'
  | 'updateMRReviewers'
  | 'addMRComment'
  | 'addMRInlineComment'
  | 'resolveMRDiscussion'
  | 'jobTrace'
  | 'retryJob'
  | 'workItemByPath'
type WebGitLabRuntimeMethod =
  | 'gitlab.diagnoseAuth'
  | 'gitlab.rateLimit'
  | 'gitlab.listMRs'
  | 'gitlab.listWorkItems'
  | 'gitlab.listIssues'
  | 'gitlab.createIssue'
  | 'gitlab.updateIssue'
  | 'gitlab.addIssueComment'
  | 'gitlab.listLabels'
  | 'gitlab.todos'
  | 'gitlab.workItemDetails'
  | 'gitlab.updateMRState'
  | 'gitlab.mergeMR'
  | 'gitlab.updateMR'
  | 'gitlab.updateMRReviewers'
  | 'gitlab.addMRComment'
  | 'gitlab.addMRInlineComment'
  | 'gitlab.resolveMRDiscussion'
  | 'gitlab.jobTrace'
  | 'gitlab.retryJob'
  | 'gitlab.workItemByPath'
type WebKeybindingDocument = {
  version: 1
  keybindings: KeybindingOverrides
  platforms: Partial<Record<KeybindingPlatform, KeybindingOverrides>>
}

export const GITHUB_WEB_RPC_METHODS = {
  repoSlug: 'github.repoSlug',
  prForBranch: 'github.prForBranch',
  issue: 'github.issue',
  workItem: 'github.workItem',
  workItemByOwnerRepo: 'github.workItemByOwnerRepo',
  workItemDetails: 'github.workItemDetails',
  prFileContents: 'github.prFileContents',
  listIssues: 'github.listIssues',
  createIssue: 'github.createIssue',
  countWorkItems: 'github.countWorkItems',
  listWorkItems: 'github.listWorkItems',
  prChecks: 'github.prChecks',
  prCheckDetails: 'github.prCheckDetails',
  rerunPRChecks: 'github.rerunPRChecks',
  prComments: 'github.prComments',
  resolveReviewThread: 'github.resolveReviewThread',
  setPRFileViewed: 'github.setPRFileViewed',
  updatePRTitle: 'github.updatePRTitle',
  mergePR: 'github.mergePR',
  setPRAutoMerge: 'github.setPRAutoMerge',
  updatePRState: 'github.updatePRState',
  requestPRReviewers: 'github.requestPRReviewers',
  removePRReviewers: 'github.removePRReviewers',
  updateIssue: 'github.updateIssue',
  addIssueComment: 'github.addIssueComment',
  addPRReviewCommentReply: 'github.addPRReviewCommentReply',
  addPRReviewComment: 'github.addPRReviewComment',
  listLabels: 'github.listLabels',
  listAssignableUsers: 'github.listAssignableUsers',
  rateLimit: 'github.rateLimit',
  listAccessibleProjects: 'github.project.listAccessible',
  resolveProjectRef: 'github.project.resolveRef',
  listProjectViews: 'github.project.listViews',
  getProjectViewTable: 'github.project.viewTable',
  projectWorkItemDetailsBySlug: 'github.project.workItemDetailsBySlug',
  updateProjectItemField: 'github.project.updateItemField',
  clearProjectItemField: 'github.project.clearItemField',
  updateIssueBySlug: 'github.project.updateIssueBySlug',
  updatePullRequestBySlug: 'github.project.updatePullRequestBySlug',
  addIssueCommentBySlug: 'github.project.addIssueCommentBySlug',
  updateIssueCommentBySlug: 'github.project.updateIssueCommentBySlug',
  deleteIssueCommentBySlug: 'github.project.deleteIssueCommentBySlug',
  listLabelsBySlug: 'github.project.listLabelsBySlug',
  listAssignableUsersBySlug: 'github.project.listAssignableUsersBySlug',
  listIssueTypesBySlug: 'github.project.listIssueTypesBySlug',
  updateIssueTypeBySlug: 'github.project.updateIssueTypeBySlug'
} as const satisfies Record<WebGitHubRouteKey, WebGitHubRuntimeMethod>

export const GITLAB_WEB_RPC_METHODS = {
  diagnoseAuth: 'gitlab.diagnoseAuth',
  rateLimit: 'gitlab.rateLimit',
  listMRs: 'gitlab.listMRs',
  listWorkItems: 'gitlab.listWorkItems',
  listIssues: 'gitlab.listIssues',
  createIssue: 'gitlab.createIssue',
  updateIssue: 'gitlab.updateIssue',
  addIssueComment: 'gitlab.addIssueComment',
  listLabels: 'gitlab.listLabels',
  todos: 'gitlab.todos',
  workItemDetails: 'gitlab.workItemDetails',
  closeMR: 'gitlab.updateMRState',
  reopenMR: 'gitlab.updateMRState',
  mergeMR: 'gitlab.mergeMR',
  updateMR: 'gitlab.updateMR',
  updateMRReviewers: 'gitlab.updateMRReviewers',
  addMRComment: 'gitlab.addMRComment',
  addMRInlineComment: 'gitlab.addMRInlineComment',
  resolveMRDiscussion: 'gitlab.resolveMRDiscussion',
  jobTrace: 'gitlab.jobTrace',
  retryJob: 'gitlab.retryJob',
  workItemByPath: 'gitlab.workItemByPath'
} as const satisfies Record<WebGitLabRouteKey, WebGitLabRuntimeMethod>

const WEB_KEYBINDING_PLATFORMS: readonly KeybindingPlatform[] = ['darwin', 'linux', 'win32']
const webKeybindingListeners = new Set<(snapshot: KeybindingFileSnapshot) => void>()

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
      getIdentity: () =>
        Promise.resolve({
          name: 'Orca',
          isDev: false,
          devLabel: null,
          devBranch: null,
          devWorktreeName: null,
          devRepoRoot: null,
          dockBadgeLabel: null
        }),
      getFeatureWallAssetBaseUrl: () => Promise.resolve('/'),
      relaunch: () => Promise.resolve(window.location.reload()),
      restart: () => Promise.resolve(window.location.reload()),
      reload: () => Promise.resolve(window.location.reload()),
      getKeyboardInputSourceId: () => Promise.resolve(null),
      setUnreadDockBadgeCount: () => Promise.resolve(),
      getFloatingTerminalCwd: () => Promise.resolve(''),
      getFloatingMarkdownDirectory: () => Promise.resolve(''),
      pickFloatingMarkdownDocument: () => Promise.resolve(null),
      pickFloatingWorkspaceDirectory: () => Promise.resolve(null)
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
    keybindings: createWebKeybindingsApi(),
    ui: createWebUiApi(),
    crashReports: {
      getLatestPending: () => Promise.resolve(null),
      getLatestReport: () => Promise.resolve(null),
      dismiss: () => Promise.resolve(null),
      recordRendererError: () => Promise.resolve({ ok: true, report: null, deduped: true }),
      recordBreadcrumb: () => {},
      submit: () =>
        Promise.resolve({
          ok: false,
          status: null,
          error: 'Unavailable on web.'
        }),
      copyLatestDiagnostics: () => Promise.resolve({ ok: false, error: 'Unavailable on web.' })
    },
    diagnostics: {
      getStatus: () =>
        Promise.resolve({
          localFileEnabled: false,
          otlpEnabled: false,
          bundleEnabled: false,
          otlpStatus: 'Unavailable on web',
          traceFilePath: '',
          traceFamilySize: 0
        }),
      openTraceFolder: () => Promise.resolve(),
      clearTraces: () => Promise.resolve(),
      collectBundle: () => Promise.reject(new Error('Diagnostic bundles are unavailable on web.')),
      openBundlePreview: () =>
        Promise.reject(new Error('Diagnostic bundles are unavailable on web.')),
      discardBundlePreview: () => Promise.resolve(),
      uploadBundle: () => Promise.reject(new Error('Diagnostic bundles are unavailable on web.')),
      deleteBundle: () => Promise.reject(new Error('Diagnostic bundles are unavailable on web.'))
    },
    session: {
      get: () => Promise.resolve(getStoredWorkspaceSession()),
      set: async (session) => {
        writeJson(SESSION_STORAGE_KEY, sanitizeWebRuntimeWorkspaceSession(session))
      },
      patch: async (patch: WorkspaceSessionPatch) => {
        writeJson(
          SESSION_STORAGE_KEY,
          sanitizeWebRuntimeWorkspaceSession({
            ...getStoredWorkspaceSession(),
            ...patch
          })
        )
      },
      setSync: (session) => {
        writeJson(SESSION_STORAGE_KEY, sanitizeWebRuntimeWorkspaceSession(session))
      }
    },
    onboarding: {
      get: () => Promise.resolve(getStoredOnboarding()),
      update: async (updates) => {
        const current = getStoredOnboarding()
        const next: OnboardingState = {
          ...current,
          ...updates,
          flowVersion: ONBOARDING_FLOW_VERSION,
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
    gl: createGitLabApi(),
    hostedReview: createRuntimeNamespaceApi('hostedReview'),
    linear: createRuntimeNamespaceApi('linear'),
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
    skills: createSkillsApi(),
    pty: createPtyApi(),
    ssh: createSshApi(),
    wsl: {
      isAvailable: () => callRuntimeResult<boolean>('host.wsl.isAvailable').catch(() => false),
      listDistros: () => callRuntimeResult<string[]>('host.wsl.listDistros').catch(() => [])
    },
    pwsh: {
      isAvailable: () => callRuntimeResult<boolean>('host.pwsh.isAvailable').catch(() => false)
    },
    gitBash: {
      isAvailable: () => callRuntimeResult<boolean>('host.gitBash.isAvailable').catch(() => false)
    },
    agentStatus: {
      onSet: () => noopUnsubscribe,
      getSnapshot: () => Promise.resolve([]),
      inferInterrupt: () => Promise.resolve(false),
      onMigrationUnsupported: () => noopUnsubscribe,
      onMigrationUnsupportedClear: () => noopUnsubscribe,
      getMigrationUnsupportedSnapshot: () => Promise.resolve([]),
      drop: () => {}
    },
    mobile: {
      listNetworkInterfaces: () => Promise.resolve({ interfaces: [] }),
      getPairingQR: () => Promise.resolve({ available: false }),
      getRuntimePairingUrl: () => Promise.resolve({ available: false }),
      listDevices: () => Promise.resolve({ devices: [] }),
      revokeDevice: () => Promise.resolve({ revoked: false }),
      listRuntimeAccessGrants: () => Promise.resolve({ grants: [] }),
      revokeRuntimeAccess: () => Promise.resolve({ revoked: false }),
      isWebSocketReady: () => Promise.resolve({ ready: Boolean(activeEnvironment), endpoint: null })
    },
    telemetryTrack: () => Promise.resolve(),
    telemetrySetOptIn: () => Promise.resolve(),
    telemetryGetConsentState: () =>
      Promise.resolve({ optedIn: false, source: 'default', blockedByEnv: false } as never),
    telemetryAcknowledgeBanner: () => Promise.resolve()
  }
}

function createEmptyWebKeybindingDocument(): WebKeybindingDocument {
  return {
    version: 1,
    keybindings: {},
    platforms: {
      darwin: {},
      linux: {},
      win32: {}
    }
  }
}

function getWebKeybindingPlatform(): KeybindingPlatform {
  return getKeybindingPlatform(getBrowserPlatform())
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeStoredWebOverrides(
  value: unknown,
  section: string,
  diagnostics: KeybindingFileDiagnostic[]
): KeybindingOverrides {
  if (value === undefined) {
    return {}
  }
  if (!isJsonObject(value)) {
    diagnostics.push({ severity: 'error', section, message: `${section} must be an object.` })
    return {}
  }

  const overrides: KeybindingOverrides = {}
  for (const [actionId, rawBindings] of Object.entries(value)) {
    if (!isKeybindingActionId(actionId)) {
      diagnostics.push({
        severity: 'warning',
        section,
        actionId,
        message: `Unknown keybinding action "${actionId}" was ignored.`
      })
      continue
    }
    if (
      !Array.isArray(rawBindings) ||
      !rawBindings.every((binding) => typeof binding === 'string')
    ) {
      diagnostics.push({
        severity: 'error',
        section,
        actionId,
        message: `Shortcut for "${actionId}" was ignored: Use a string array.`
      })
      continue
    }
    const normalized = normalizeKeybindingArrayForAction(actionId, rawBindings)
    if (!Array.isArray(normalized)) {
      const error = normalized.ok ? 'Unable to parse shortcut.' : normalized.error
      diagnostics.push({
        severity: 'error',
        section,
        actionId,
        message: `Shortcut for "${actionId}" was ignored: ${error}`
      })
      continue
    }
    overrides[actionId] = normalized
  }
  return overrides
}

function normalizeWebPlatformOverrides(
  value: unknown,
  diagnostics: KeybindingFileDiagnostic[]
): Partial<Record<KeybindingPlatform, KeybindingOverrides>> {
  if (value === undefined) {
    return {}
  }
  if (!isJsonObject(value)) {
    diagnostics.push({
      severity: 'error',
      section: 'platforms',
      message: 'platforms must be an object with darwin, linux, or win32 sections.'
    })
    return {}
  }

  const result: Partial<Record<KeybindingPlatform, KeybindingOverrides>> = {}
  for (const [platform, overrides] of Object.entries(value)) {
    if (!WEB_KEYBINDING_PLATFORMS.includes(platform as KeybindingPlatform)) {
      diagnostics.push({
        severity: 'warning',
        section: `platforms.${platform}`,
        message: `Unknown platform "${platform}" was ignored.`
      })
      continue
    }
    result[platform as KeybindingPlatform] = normalizeStoredWebOverrides(
      overrides,
      `platforms.${platform}`,
      diagnostics
    )
  }
  return result
}

function removeConflictingWebOverrides(
  platform: KeybindingPlatform,
  overrides: KeybindingOverrides,
  diagnostics: KeybindingFileDiagnostic[]
): KeybindingOverrides {
  let next = { ...overrides }
  for (let attempt = 0; attempt < 20; attempt++) {
    const conflicts = findKeybindingConflicts(platform, next)
    const conflictingOverrides = new Set<KeybindingActionId>()
    for (const conflict of conflicts) {
      for (const actionId of conflict.actionIds) {
        if (Object.prototype.hasOwnProperty.call(next, actionId)) {
          conflictingOverrides.add(actionId)
        }
      }
    }
    if (conflictingOverrides.size === 0) {
      return next
    }
    for (const actionId of conflictingOverrides) {
      delete next[actionId]
    }
    diagnostics.push({
      severity: 'error',
      message: `Conflicting custom shortcuts were ignored: ${Array.from(conflictingOverrides)
        .map((actionId) => actionId)
        .join(', ')}.`
    })
  }
  return next
}

function readWebKeybindingDocument(): WebKeybindingDocument {
  const document = readJson(KEYBINDINGS_STORAGE_KEY, createEmptyWebKeybindingDocument())
  return {
    version: 1,
    keybindings: isJsonObject(document.keybindings)
      ? (document.keybindings as KeybindingOverrides)
      : {},
    platforms: isJsonObject(document.platforms)
      ? (document.platforms as Partial<Record<KeybindingPlatform, KeybindingOverrides>>)
      : {}
  }
}

function getWebKeybindingSnapshot(): KeybindingFileSnapshot {
  const platform = getWebKeybindingPlatform()
  const diagnostics: KeybindingFileDiagnostic[] = []
  const document = readWebKeybindingDocument()
  const commonOverrides = normalizeStoredWebOverrides(
    document.keybindings,
    'keybindings',
    diagnostics
  )
  const platformOverrides = normalizeWebPlatformOverrides(document.platforms, diagnostics)
  const overrides = removeConflictingWebOverrides(
    platform,
    {
      ...commonOverrides,
      ...platformOverrides[platform]
    },
    diagnostics
  )

  return {
    path: 'Browser local storage',
    platform,
    exists: window.localStorage.getItem(KEYBINDINGS_STORAGE_KEY) !== null,
    overrides,
    commonOverrides,
    platformOverrides,
    diagnostics
  }
}

function writeWebKeybindingAction(
  actionId: KeybindingActionId,
  bindings: string[] | null
): KeybindingFileSnapshot {
  if (!isKeybindingActionId(actionId)) {
    throw new Error(`Unknown keybinding action "${actionId}".`)
  }
  const normalizedBindings =
    bindings === null ? null : normalizeKeybindingArrayForAction(actionId, bindings)
  if (normalizedBindings !== null && !Array.isArray(normalizedBindings)) {
    throw new Error(normalizedBindings.ok ? 'Unable to parse shortcut.' : normalizedBindings.error)
  }

  const platform = getWebKeybindingPlatform()
  const currentSnapshot = getWebKeybindingSnapshot()
  const candidateOverrides = { ...currentSnapshot.overrides }
  if (normalizedBindings === null) {
    delete candidateOverrides[actionId]
  } else {
    candidateOverrides[actionId] = normalizedBindings
  }
  const blockingConflict = findKeybindingConflicts(platform, candidateOverrides).find((conflict) =>
    conflict.actionIds.includes(actionId)
  )
  if (blockingConflict) {
    throw new Error(
      `${formatKeybindingList([blockingConflict.binding], platform)} conflicts with another shortcut.`
    )
  }

  const activePlatform: KeybindingOverrides = { ...currentSnapshot.platformOverrides[platform] }
  if (normalizedBindings === null) {
    delete activePlatform[actionId]
  } else {
    activePlatform[actionId] = normalizedBindings
  }

  writeJson(KEYBINDINGS_STORAGE_KEY, {
    version: 1,
    keybindings: currentSnapshot.commonOverrides,
    platforms: {
      ...currentSnapshot.platformOverrides,
      darwin: currentSnapshot.platformOverrides.darwin ?? {},
      linux: currentSnapshot.platformOverrides.linux ?? {},
      win32: currentSnapshot.platformOverrides.win32 ?? {},
      [platform]: activePlatform
    }
  } satisfies WebKeybindingDocument)

  const snapshot = getWebKeybindingSnapshot()
  notifyWebKeybindingListeners(snapshot)
  return snapshot
}

function notifyWebKeybindingListeners(snapshot: KeybindingFileSnapshot): void {
  for (const listener of webKeybindingListeners) {
    listener(snapshot)
  }
}

function createWebKeybindingsApi(): WebKeybindingsApi {
  return {
    get: () => Promise.resolve(getWebKeybindingSnapshot()),
    ensureFile: () => Promise.resolve(getWebKeybindingSnapshot()),
    setAction: async ({ actionId, bindings }) => writeWebKeybindingAction(actionId, bindings),
    reload: () => {
      const snapshot = getWebKeybindingSnapshot()
      notifyWebKeybindingListeners(snapshot)
      return Promise.resolve(snapshot)
    },
    openFile: () => Promise.resolve(getWebKeybindingSnapshot()),
    revealFile: () => Promise.resolve(getWebKeybindingSnapshot()),
    onChanged: (callback) => {
      webKeybindingListeners.add(callback)
      const onStorage = (event: StorageEvent): void => {
        if (event.key === KEYBINDINGS_STORAGE_KEY) {
          callback(getWebKeybindingSnapshot())
        }
      }
      window.addEventListener('storage', onStorage)
      return () => {
        webKeybindingListeners.delete(callback)
        window.removeEventListener('storage', onStorage)
      }
    }
  }
}

function createRuntimeApi(): NonNullable<Partial<PreloadApi>['runtime']> {
  return {
    syncWindowGraph: async (_graph: RuntimeSyncWindowGraph) => getRemoteRuntimeStatus(),
    getStatus: () => getRemoteRuntimeStatus(),
    call: ({ method, params }) => callRuntimeEnvelope(method, params),
    getTerminalFitOverrides: () => Promise.resolve([]),
    getTerminalDrivers: () => Promise.resolve([]),
    getBrowserDrivers: () => Promise.resolve([]),
    restoreTerminalFit: () => Promise.resolve({ restored: false }),
    reclaimBrowserForDesktop: () => Promise.resolve({ reclaimed: false }),
    onTerminalFitOverrideChanged: () => noopUnsubscribe,
    onTerminalDriverChanged: () => noopUnsubscribe,
    onBrowserDriverChanged: () => noopUnsubscribe
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
    add: async ({ path, kind }) => {
      invalidateRuntimeWorktreeCaches()
      return callRuntimeResult('repo.add', { path, kind })
    },
    remove: async ({ repoId }) => {
      await callRuntimeResult('repo.rm', { repo: repoId })
      invalidateRuntimeWorktreeCaches()
    },
    reorder: async ({ orderedIds }) => callRuntimeResult('repo.reorder', { orderedIds }),
    update: async ({ repoId, updates }) =>
      (await callRuntimeResult<{ repo: Repo }>('repo.update', { repo: repoId, updates })).repo,
    pickFolder: () => Promise.resolve(null),
    pickDirectory: () => Promise.resolve(null),
    clone: async ({ url, destination }) => {
      invalidateRuntimeWorktreeCaches()
      return (
        await callRuntimeResult<{ repo: Repo }>('repo.clone', { url, destination }, 10 * 60_000)
      ).repo
    },
    cloneAbort: () => Promise.resolve(),
    addRemote: async ({ remotePath, displayName, kind }) => {
      invalidateRuntimeWorktreeCaches()
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
    create: async ({ parentPath, name, kind }) => {
      invalidateRuntimeWorktreeCaches()
      return callRuntimeResult('repo.create', { parentPath, name, kind })
    },
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
    searchBaseRefDetails: async ({ repoId, query, limit }) => {
      const result = await callRuntimeResult<{
        refs: string[]
        refDetails?: { refName: string; localBranchName: string }[]
      }>('repo.searchRefs', {
        repo: repoId,
        query,
        limit
      })
      return result.refDetails ?? result.refs.map(legacyBaseRefSearchResult)
    },
    onChanged: () => noopUnsubscribe
  }
}

function createWorktreesApi(): NonNullable<Partial<PreloadApi>['worktrees']> {
  return {
    list: async ({ repoId }) =>
      (
        await callRuntimeResult<{ worktrees: Worktree[] }>('worktree.list', {
          repo: repoId,
          limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT
        })
      ).worktrees,
    listDetected: async ({ repoId }) => callRuntimeDetectedWorktrees(repoId),
    listAll: () => listAllRuntimeWorktrees(),
    create: async (args) => {
      invalidateRuntimeWorktreeCaches()
      return callRuntimeResult('worktree.create', {
        repo: args.repoId,
        name: args.name,
        baseBranch: args.baseBranch,
        branchNameOverride: args.branchNameOverride,
        linkedIssue: args.linkedIssue,
        linkedPR: args.linkedPR,
        linkedLinearIssue: args.linkedLinearIssue,
        linkedGitLabIssue: args.linkedGitLabIssue,
        linkedGitLabMR: args.linkedGitLabMR,
        displayName: args.displayName,
        sparseCheckout: args.sparseCheckout,
        pushTarget: args.pushTarget,
        setupDecision: args.setupDecision,
        createdWithAgent: args.createdWithAgent,
        pendingFirstAgentMessageRename: args.pendingFirstAgentMessageRename,
        workspaceStatus: args.workspaceStatus,
        manualOrder: args.manualOrder
      })
    },
    prefetchCreateBase: async ({ repoId, baseBranch }) => {
      await callRuntimeResult('worktree.prefetchCreateBase', {
        repo: repoId,
        baseBranch
      })
    },
    resolvePrBase: async ({ repoId, prNumber, headRefName, isCrossRepository }) =>
      callRuntimeResult('worktree.resolvePrBase', {
        repo: repoId,
        prNumber,
        headRefName,
        isCrossRepository
      }),
    resolveMrBase: async ({ repoId, mrIid, sourceBranch, isCrossRepository }) =>
      callRuntimeResult('worktree.resolveMrBase', {
        repo: repoId,
        mrIid,
        sourceBranch,
        isCrossRepository
      }),
    remove: async ({ worktreeId, force }) => {
      invalidateRuntimeWorktreeCaches()
      return callRuntimeResult<RemoveWorktreeResult>('worktree.rm', { worktree: worktreeId, force })
    },
    forceDeletePreservedBranch: ({ worktreeId, branchName, expectedHead }) =>
      callRuntimeResult<ForceDeleteWorktreeBranchResult>('worktree.forceDeleteBranch', {
        worktree: worktreeId,
        branchName,
        expectedHead
      }),
    updateMeta: async ({ worktreeId, updates }) =>
      (
        await callRuntimeResult<{ worktree: Worktree }>('worktree.set', {
          worktree: worktreeId,
          ...updates
        })
      ).worktree,
    listLineage: async () =>
      (
        await callRuntimeResult<{ lineage: Record<string, WorktreeLineage> }>(
          'worktree.lineageList'
        )
      ).lineage,
    updateLineage: async ({ worktreeId, parentWorktreeId, noParent }) => {
      invalidateRuntimeWorktreeCaches()
      const result = await callRuntimeResult<{
        worktree: Worktree & { lineage?: WorktreeLineage | null }
      }>('worktree.set', {
        worktree: worktreeId,
        parentWorktree: parentWorktreeId,
        noParent
      })
      return result.worktree.lineage ?? null
    },
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
    pathExists: async ({ filePath }) => {
      try {
        const file = await resolveRuntimeFilePath(filePath)
        await callRuntimeResult('files.stat', {
          worktree: file.worktree.id,
          relativePath: file.relativePath
        })
        return true
      } catch (error) {
        if (isMissingPathError(error)) {
          return false
        }
        throw error
      }
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
    status: async ({ worktreePath, includeIgnored }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.status', { worktree: worktree.id, includeIgnored })
    },
    checkIgnored: async ({ worktreePath, paths }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.checkIgnored', { worktree: worktree.id, paths })
    },
    history: async ({ worktreePath, limit, baseRef }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.history', { worktree: worktree.id, limit, baseRef })
    },
    conflictOperation: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.conflictOperation', { worktree: worktree.id })
    },
    abortMerge: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.abortMerge', { worktree: worktree.id })
    },
    abortRebase: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.abortRebase', { worktree: worktree.id })
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
    commitCompare: async ({ worktreePath, commitId }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.commitCompare', { worktree: worktree.id, commitId })
    },
    upstreamStatus: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.upstreamStatus', { worktree: worktree.id, pushTarget })
    },
    fetch: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.fetch', { worktree: worktree.id, pushTarget })
    },
    push: async ({ worktreePath, publish, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.push', { worktree: worktree.id, publish, pushTarget })
    },
    pull: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.pull', { worktree: worktree.id, pushTarget })
    },
    fastForward: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.fastForward', { worktree: worktree.id, pushTarget })
    },
    rebaseFromBase: async ({ worktreePath, baseRef }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.rebaseFromBase', { worktree: worktree.id, baseRef })
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
    commitDiff: async ({ worktreePath, filePath, commitOid, parentOid, oldPath }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.commitDiff', {
        worktree: file.worktree.id,
        filePath: file.relativePath,
        commitOid,
        parentOid,
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
    discoverCommitMessageModels: async () => ({
      success: false,
      error: 'Commit message model discovery is unavailable in the web client.'
    }),
    cancelGenerateCommitMessage: () => Promise.resolve(),
    generatePullRequestFields: async () => ({
      success: false,
      error: 'Pull request detail generation is unavailable in the web client.'
    }),
    cancelGeneratePullRequestFields: () => Promise.resolve(),
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
    setAnnotationViewportBridge: () => Promise.resolve(false),
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

function createGitHubApi(): WebGitHubApi {
  const route = <Result>(method: WebGitHubRuntimeMethod, args?: unknown): Promise<Result> =>
    callRuntimeResult<Result>(method, mapRepoPathArg(args))
  const githubApi = {
    viewer: () => Promise.resolve(null),
    repoSlug: (args) => route<WebGitHubResult<'repoSlug'>>(GITHUB_WEB_RPC_METHODS.repoSlug, args),
    prForBranch: (args) =>
      route<WebGitHubResult<'prForBranch'>>(GITHUB_WEB_RPC_METHODS.prForBranch, args),
    refreshPRNow: async ({ candidate }) => {
      const pr = await route<WebGitHubResult<'prForBranch'>>(GITHUB_WEB_RPC_METHODS.prForBranch, {
        repoPath: candidate.repoPath,
        repoId: candidate.repoId,
        branch: candidate.branch,
        linkedPRNumber: candidate.linkedPRNumber ?? null,
        fallbackPRNumber: candidate.fallbackPRNumber ?? null
      })
      return pr
        ? { kind: 'found', pr, fetchedAt: Date.now() }
        : { kind: 'no-pr', fetchedAt: Date.now() }
    },
    enqueuePRRefresh: () => Promise.resolve(false),
    reportVisiblePRRefreshCandidates: () => Promise.resolve(false),
    onPRRefreshEvent: () => noopUnsubscribe,
    issue: (args) => route<WebGitHubResult<'issue'>>(GITHUB_WEB_RPC_METHODS.issue, args),
    workItem: (args) => route<WebGitHubResult<'workItem'>>(GITHUB_WEB_RPC_METHODS.workItem, args),
    workItemByOwnerRepo: ({ repo: ownerRepo, ...args }) =>
      route<WebGitHubResult<'workItemByOwnerRepo'>>(GITHUB_WEB_RPC_METHODS.workItemByOwnerRepo, {
        ...args,
        ownerRepo
      }),
    workItemDetails: (args) =>
      route<WebGitHubResult<'workItemDetails'>>(GITHUB_WEB_RPC_METHODS.workItemDetails, args),
    prFileContents: (args) =>
      route<WebGitHubResult<'prFileContents'>>(GITHUB_WEB_RPC_METHODS.prFileContents, args),
    listIssues: (args) =>
      route<WebGitHubResult<'listIssues'>>(GITHUB_WEB_RPC_METHODS.listIssues, args),
    createIssue: (args) =>
      route<WebGitHubResult<'createIssue'>>(GITHUB_WEB_RPC_METHODS.createIssue, args),
    countWorkItems: (args) =>
      route<WebGitHubResult<'countWorkItems'>>(GITHUB_WEB_RPC_METHODS.countWorkItems, args),
    listWorkItems: (args) =>
      route<WebGitHubResult<'listWorkItems'>>(GITHUB_WEB_RPC_METHODS.listWorkItems, args),
    prChecks: (args) => route<WebGitHubResult<'prChecks'>>(GITHUB_WEB_RPC_METHODS.prChecks, args),
    prCheckDetails: (args) =>
      route<WebGitHubResult<'prCheckDetails'>>(GITHUB_WEB_RPC_METHODS.prCheckDetails, args),
    rerunPRChecks: (args) =>
      route<WebGitHubResult<'rerunPRChecks'>>(GITHUB_WEB_RPC_METHODS.rerunPRChecks, args),
    prComments: (args) =>
      route<WebGitHubResult<'prComments'>>(GITHUB_WEB_RPC_METHODS.prComments, args),
    resolveReviewThread: (args) =>
      route<WebGitHubResult<'resolveReviewThread'>>(
        GITHUB_WEB_RPC_METHODS.resolveReviewThread,
        args
      ),
    setPRFileViewed: (args) =>
      route<WebGitHubResult<'setPRFileViewed'>>(GITHUB_WEB_RPC_METHODS.setPRFileViewed, args),
    updatePRTitle: (args) =>
      route<WebGitHubResult<'updatePRTitle'>>(GITHUB_WEB_RPC_METHODS.updatePRTitle, args),
    mergePR: (args) => route<WebGitHubResult<'mergePR'>>(GITHUB_WEB_RPC_METHODS.mergePR, args),
    setPRAutoMerge: (args) =>
      route<WebGitHubResult<'setPRAutoMerge'>>(GITHUB_WEB_RPC_METHODS.setPRAutoMerge, args),
    updatePRState: (args) =>
      route<WebGitHubResult<'updatePRState'>>(GITHUB_WEB_RPC_METHODS.updatePRState, args),
    requestPRReviewers: (args) =>
      route<WebGitHubResult<'requestPRReviewers'>>(GITHUB_WEB_RPC_METHODS.requestPRReviewers, args),
    removePRReviewers: (args) =>
      route<WebGitHubResult<'removePRReviewers'>>(GITHUB_WEB_RPC_METHODS.removePRReviewers, args),
    updateIssue: (args) =>
      route<WebGitHubResult<'updateIssue'>>(GITHUB_WEB_RPC_METHODS.updateIssue, args),
    addIssueComment: (args) =>
      route<WebGitHubResult<'addIssueComment'>>(GITHUB_WEB_RPC_METHODS.addIssueComment, args),
    addPRReviewCommentReply: (args) =>
      route<WebGitHubResult<'addPRReviewCommentReply'>>(
        GITHUB_WEB_RPC_METHODS.addPRReviewCommentReply,
        args
      ),
    addPRReviewComment: (args) =>
      route<WebGitHubResult<'addPRReviewComment'>>(GITHUB_WEB_RPC_METHODS.addPRReviewComment, args),
    listLabels: (args) =>
      route<WebGitHubResult<'listLabels'>>(GITHUB_WEB_RPC_METHODS.listLabels, args),
    listAssignableUsers: (args) =>
      route<WebGitHubResult<'listAssignableUsers'>>(
        GITHUB_WEB_RPC_METHODS.listAssignableUsers,
        args
      ),
    onWorkItemMutated: () => noopUnsubscribe,
    checkOrcaStarred: () => Promise.resolve(null),
    starOrca: () => Promise.resolve(false),
    rateLimit: (args) =>
      route<WebGitHubResult<'rateLimit'>>(GITHUB_WEB_RPC_METHODS.rateLimit, args),
    diagnoseAuth: () =>
      Promise.resolve({ ok: false, message: 'Unavailable in the web client.' } as never),
    listAccessibleProjects: () =>
      route<WebGitHubResult<'listAccessibleProjects'>>(
        GITHUB_WEB_RPC_METHODS.listAccessibleProjects
      ),
    resolveProjectRef: (args) =>
      route<WebGitHubResult<'resolveProjectRef'>>(GITHUB_WEB_RPC_METHODS.resolveProjectRef, args),
    listProjectViews: (args) =>
      route<WebGitHubResult<'listProjectViews'>>(GITHUB_WEB_RPC_METHODS.listProjectViews, args),
    getProjectViewTable: (args) =>
      route<WebGitHubResult<'getProjectViewTable'>>(
        GITHUB_WEB_RPC_METHODS.getProjectViewTable,
        args
      ),
    projectWorkItemDetailsBySlug: (args) =>
      route<WebGitHubResult<'projectWorkItemDetailsBySlug'>>(
        GITHUB_WEB_RPC_METHODS.projectWorkItemDetailsBySlug,
        args
      ),
    updateProjectItemField: (args) =>
      route<WebGitHubResult<'updateProjectItemField'>>(
        GITHUB_WEB_RPC_METHODS.updateProjectItemField,
        args
      ),
    clearProjectItemField: (args) =>
      route<WebGitHubResult<'clearProjectItemField'>>(
        GITHUB_WEB_RPC_METHODS.clearProjectItemField,
        args
      ),
    updateIssueBySlug: (args) =>
      route<WebGitHubResult<'updateIssueBySlug'>>(GITHUB_WEB_RPC_METHODS.updateIssueBySlug, args),
    updatePullRequestBySlug: (args) =>
      route<WebGitHubResult<'updatePullRequestBySlug'>>(
        GITHUB_WEB_RPC_METHODS.updatePullRequestBySlug,
        args
      ),
    addIssueCommentBySlug: (args) =>
      route<WebGitHubResult<'addIssueCommentBySlug'>>(
        GITHUB_WEB_RPC_METHODS.addIssueCommentBySlug,
        args
      ),
    updateIssueCommentBySlug: (args) =>
      route<WebGitHubResult<'updateIssueCommentBySlug'>>(
        GITHUB_WEB_RPC_METHODS.updateIssueCommentBySlug,
        args
      ),
    deleteIssueCommentBySlug: (args) =>
      route<WebGitHubResult<'deleteIssueCommentBySlug'>>(
        GITHUB_WEB_RPC_METHODS.deleteIssueCommentBySlug,
        args
      ),
    listLabelsBySlug: (args) =>
      route<WebGitHubResult<'listLabelsBySlug'>>(GITHUB_WEB_RPC_METHODS.listLabelsBySlug, args),
    listAssignableUsersBySlug: (args) =>
      route<WebGitHubResult<'listAssignableUsersBySlug'>>(
        GITHUB_WEB_RPC_METHODS.listAssignableUsersBySlug,
        args
      ),
    listIssueTypesBySlug: (args) =>
      route<WebGitHubResult<'listIssueTypesBySlug'>>(
        GITHUB_WEB_RPC_METHODS.listIssueTypesBySlug,
        args
      ),
    updateIssueTypeBySlug: (args) =>
      route<WebGitHubResult<'updateIssueTypeBySlug'>>(
        GITHUB_WEB_RPC_METHODS.updateIssueTypeBySlug,
        args
      )
  } satisfies WebGitHubApi

  return githubApi
}

function createGitLabApi(): WebGitLabApi {
  const route = <Result>(method: WebGitLabRuntimeMethod, args?: unknown): Promise<Result> =>
    callRuntimeResult<Result>(method, mapRepoPathArg(args))

  const gitLabApi = {
    viewer: () => Promise.resolve(null),
    diagnoseAuth: () => route<WebGitLabResult<'diagnoseAuth'>>(GITLAB_WEB_RPC_METHODS.diagnoseAuth),
    rateLimit: (args) =>
      route<WebGitLabResult<'rateLimit'>>(GITLAB_WEB_RPC_METHODS.rateLimit, args),
    projectSlug: () => Promise.resolve(null),
    mrForBranch: () => Promise.resolve(null),
    mr: () => Promise.resolve(null),
    listMRs: (args) => route<WebGitLabResult<'listMRs'>>(GITLAB_WEB_RPC_METHODS.listMRs, args),
    listWorkItems: (args) =>
      route<WebGitLabResult<'listWorkItems'>>(GITLAB_WEB_RPC_METHODS.listWorkItems, args),
    issue: () => Promise.resolve(null),
    listIssues: (args) =>
      route<WebGitLabResult<'listIssues'>>(GITLAB_WEB_RPC_METHODS.listIssues, args),
    createIssue: (args) =>
      route<WebGitLabResult<'createIssue'>>(GITLAB_WEB_RPC_METHODS.createIssue, args),
    updateIssue: (args) =>
      route<WebGitLabResult<'updateIssue'>>(GITLAB_WEB_RPC_METHODS.updateIssue, args),
    addIssueComment: (args) =>
      route<WebGitLabResult<'addIssueComment'>>(GITLAB_WEB_RPC_METHODS.addIssueComment, args),
    listLabels: (args) =>
      route<WebGitLabResult<'listLabels'>>(GITLAB_WEB_RPC_METHODS.listLabels, args),
    listAssignableUsers: () => Promise.resolve([]),
    todos: (args) => route<WebGitLabResult<'todos'>>(GITLAB_WEB_RPC_METHODS.todos, args),
    workItemDetails: (args) =>
      route<WebGitLabResult<'workItemDetails'>>(GITLAB_WEB_RPC_METHODS.workItemDetails, args),
    closeMR: (args) =>
      route<WebGitLabResult<'closeMR'>>(GITLAB_WEB_RPC_METHODS.closeMR, {
        ...args,
        state: 'closed'
      }),
    reopenMR: (args) =>
      route<WebGitLabResult<'reopenMR'>>(GITLAB_WEB_RPC_METHODS.reopenMR, {
        ...args,
        state: 'opened'
      }),
    mergeMR: (args) => route<WebGitLabResult<'mergeMR'>>(GITLAB_WEB_RPC_METHODS.mergeMR, args),
    updateMR: (args) => route<WebGitLabResult<'updateMR'>>(GITLAB_WEB_RPC_METHODS.updateMR, args),
    updateMRReviewers: (args) =>
      route<WebGitLabResult<'updateMRReviewers'>>(GITLAB_WEB_RPC_METHODS.updateMRReviewers, args),
    addMRComment: (args) =>
      route<WebGitLabResult<'addMRComment'>>(GITLAB_WEB_RPC_METHODS.addMRComment, args),
    addMRInlineComment: (args) =>
      route<WebGitLabResult<'addMRInlineComment'>>(GITLAB_WEB_RPC_METHODS.addMRInlineComment, args),
    resolveMRDiscussion: (args) =>
      route<WebGitLabResult<'resolveMRDiscussion'>>(
        GITLAB_WEB_RPC_METHODS.resolveMRDiscussion,
        args
      ),
    jobTrace: (args) => route<WebGitLabResult<'jobTrace'>>(GITLAB_WEB_RPC_METHODS.jobTrace, args),
    retryJob: (args) => route<WebGitLabResult<'retryJob'>>(GITLAB_WEB_RPC_METHODS.retryJob, args),
    workItemByPath: (args) =>
      route<WebGitLabResult<'workItemByPath'>>(GITLAB_WEB_RPC_METHODS.workItemByPath, args)
  } satisfies WebGitLabApi

  return gitLabApi
}

function createRuntimeNamespaceApi(prefix: string): never {
  return createFallbackProxy([prefix], (path, args) => {
    const method = `${prefix}.${path.at(-1) ?? ''}`
    return callRuntimeResult(method, mapRuntimeNamespaceArg(prefix, args[0]))
  }) as never
}

function createHooksApi(): NonNullable<Partial<PreloadApi>['hooks']> {
  return {
    check: async ({ repoId }) => callRuntimeResult('repo.hooksCheck', { repo: repoId }),
    inspectSetupScriptImports: async ({ repoId }) =>
      callRuntimeResult('repo.setupScriptImports', { repo: repoId }),
    createIssueCommandRunner: async () => ({ launched: false }) as never,
    readIssueCommand: async ({ repoId }) =>
      callRuntimeResult('repo.issueCommandRead', { repo: repoId }),
    writeIssueCommand: async ({ repoId, content }) => {
      await callRuntimeResult('repo.issueCommandWrite', { repo: repoId, content })
    }
  }
}

function createWebUiApi(): NonNullable<Partial<PreloadApi>['ui']> {
  let zoomLevel = readLocalWebUIState().uiZoomLevel
  return {
    get: async () => {
      try {
        const result = await callRuntimeResult<{ ui: PersistedUIState }>(
          'ui.get',
          undefined,
          15_000
        )
        const local = readLocalWebUIState()
        const next = {
          ...mergeWebUIState(local, result.ui),
          featureInteractions: mergeFeatureInteractionState(
            local.featureInteractions,
            result.ui.featureInteractions
          ),
          contextualToursSeenIds: mergeContextualTourSeenIds(
            local.contextualToursSeenIds,
            result.ui.contextualToursSeenIds
          )
        }
        writeJson(UI_STORAGE_KEY, next)
        zoomLevel = next.uiZoomLevel
        return next
      } catch {
        return readLocalWebUIState()
      }
    },
    set: async (updates) => {
      const next = mergeWebUIState(readLocalWebUIState(), updates)
      writeJson(UI_STORAGE_KEY, next)
      zoomLevel = next.uiZoomLevel
      try {
        await callRuntimeResult('ui.set', updates, 15_000)
      } catch {
        // Why: unpaired/offline web clients still need local UI persistence.
      }
    },
    recordFeatureInteraction: async (id: FeatureInteractionId) => {
      const current = readLocalWebUIState()
      const featureInteractions = normalizeFeatureInteractions(current.featureInteractions)
      const existing = featureInteractions[id]
      const optimistic = mergeWebUIState(current, {
        featureInteractions: {
          ...featureInteractions,
          [id]: {
            firstInteractedAt: existing?.firstInteractedAt ?? Date.now(),
            interactionCount: (existing?.interactionCount ?? 0) + 1
          }
        }
      })
      writeJson(UI_STORAGE_KEY, optimistic)
      try {
        const result = await callRuntimeResult<{ ui: PersistedUIState }>(
          'ui.recordFeatureInteraction',
          id,
          15_000
        )
        const local = readLocalWebUIState()
        const next = {
          ...mergeWebUIState(local, result.ui),
          featureInteractions: mergeFeatureInteractionState(
            local.featureInteractions,
            result.ui.featureInteractions
          ),
          contextualToursSeenIds: mergeContextualTourSeenIds(
            local.contextualToursSeenIds,
            result.ui.contextualToursSeenIds
          )
        }
        writeJson(UI_STORAGE_KEY, next)
        zoomLevel = next.uiZoomLevel
        return next
      } catch {
        return optimistic
      }
    },
    readClipboardText: () => navigator.clipboard?.readText?.() ?? Promise.resolve(''),
    readSelectionClipboardText: () =>
      Promise.reject(new Error('Selection clipboard is unavailable in the web client')),
    saveClipboardImageAsTempFile: async (args?: { connectionId?: string | null }) => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      const contentBase64 = await readClipboardImagePngBase64()
      if (!contentBase64) {
        return null
      }
      return saveClipboardImageAsTempFileInRuntime(contentBase64, args)
    },
    writeClipboardText: (text) => navigator.clipboard?.writeText?.(text) ?? Promise.resolve(),
    writeSelectionClipboardText: () =>
      Promise.reject(new Error('Selection clipboard is unavailable in the web client')),
    writeClipboardImage: () => Promise.resolve(),
    getZoomLevel: () => zoomLevel,
    setZoomLevel: (level) => {
      zoomLevel = level
    },
    isMaximized: () => Promise.resolve(false),
    onOpenSettings: () => noopUnsubscribe,
    onOpenSetupGuide: () => noopUnsubscribe,
    onOpenFeatureTour: () => noopUnsubscribe,
    onOpenCrashReport: () => noopUnsubscribe,
    onToggleLeftSidebar: () => noopUnsubscribe,
    onToggleRightSidebar: () => noopUnsubscribe,
    onToggleWorktreePalette: () => noopUnsubscribe,
    onToggleFloatingTerminal: () => noopUnsubscribe,
    onTerminalShortcutCaptured: () => noopUnsubscribe,
    onOpenQuickOpen: () => noopUnsubscribe,
    onOpenTasks: () => noopUnsubscribe,
    onOpenNewWorkspace: () => noopUnsubscribe,
    onDeleteCurrentWorkspace: () => noopUnsubscribe,
    onJumpToWorktreeIndex: () => noopUnsubscribe,
    onJumpToTabIndex: () => noopUnsubscribe,
    onWorktreeHistoryNavigate: () => noopUnsubscribe,
    onNewBrowserTab: () => noopUnsubscribe,
    onNewMarkdownTab: () => noopUnsubscribe,
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
    onSwitchRecentTab: () => noopUnsubscribe,
    onSwitchTerminalTab: () => noopUnsubscribe,
    onCtrlTabKeyDown: () => noopUnsubscribe,
    onCtrlTabKeyUp: () => noopUnsubscribe,
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
    onMoveSessionTab: () => noopUnsubscribe,
    onOpenFileFromMobile: () => noopUnsubscribe,
    onOpenDiffFromMobile: () => noopUnsubscribe,
    onMobileMarkdownRequest: () => noopUnsubscribe,
    respondMobileMarkdownRequest: () => {},
    onCloseTerminal: () => noopUnsubscribe,
    onSleepWorktree: () => noopUnsubscribe,
    onTerminalZoom: () => noopUnsubscribe,
    onFileDrop: () => noopUnsubscribe,
    syncTrafficLights: () => {},
    setMarkdownEditorFocused: () => {},
    setTerminalInputFocused: () => {},
    setFloatingTerminalInputFocused: () => {},
    setShortcutRecorderFocused: () => {},
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
    bitbucket: { configured: false, authenticated: false, account: null },
    azureDevOps: {
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    },
    gitea: {
      configured: false,
      authenticated: false,
      account: null,
      baseUrl: null,
      tokenConfigured: false
    }
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
    commandName: getBrowserPlatform() === 'linux' ? 'orca-ide' : 'orca',
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
    remove: () => Promise.resolve(status),
    getWslInstallStatus: () => Promise.resolve(status),
    installWsl: () => Promise.resolve(status),
    removeWsl: () => Promise.resolve(status)
  } as NonNullable<Partial<PreloadApi>['cli']>
}

function createAgentHooksApi(): NonNullable<Partial<PreloadApi>['agentHooks']> {
  const status = (
    agent:
      | 'claude'
      | 'openclaude'
      | 'codex'
      | 'gemini'
      | 'antigravity'
      | 'amp'
      | 'cursor'
      | 'droid'
      | 'command-code'
      | 'grok'
      | 'copilot'
      | 'hermes'
  ) =>
    Promise.resolve({
      agent,
      state: 'not_installed',
      configPath: '',
      managedHooksPresent: false,
      detail: 'Agent hook status is only available on the Orca server.'
    } as const)
  return {
    claudeStatus: () => status('claude'),
    openClaudeStatus: () => status('openclaude'),
    codexStatus: () => status('codex'),
    geminiStatus: () => status('gemini'),
    antigravityStatus: () => status('antigravity'),
    ampStatus: () => status('amp'),
    cursorStatus: () => status('cursor'),
    droidStatus: () => status('droid'),
    commandCodeStatus: () => status('command-code'),
    grokStatus: () => status('grok'),
    copilotStatus: () => status('copilot'),
    hermesStatus: () => status('hermes')
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
      callRuntimeResult<ComputerUsePermissionStatusResult>(
        'computer.permissionsStatus',
        {},
        15_000
      ),
    openSetup: (args) =>
      callRuntimeResult<ComputerUsePermissionSetupResult>(
        'computer.permissions',
        args ?? {},
        15_000
      ).catch(() => ({
        platform: getBrowserPlatform(),
        helperAppPath: null,
        openedSettings: false,
        launchedHelper: false,
        nextStep: 'Computer-use permissions are managed on the Orca server.'
      })),
    reset: () =>
      Promise.resolve({
        platform: getBrowserPlatform(),
        helperAppPath: null,
        helperUnavailableReason: 'web_client',
        bundleId: null,
        permissions: []
      })
  }
}

function createSkillsApi(): NonNullable<Partial<PreloadApi>['skills']> {
  return {
    discover: () =>
      callRuntimeResult<SkillDiscoveryResult>('skills.discover', undefined, 15_000).catch(() => ({
        skills: [],
        sources: [],
        scannedAt: Date.now()
      }))
  }
}

function createNotificationsApi(): NonNullable<Partial<PreloadApi>['notifications']> {
  return {
    dispatch: () => Promise.resolve({ delivered: false, reason: 'not-supported' }),
    dismiss: () => Promise.resolve({ dismissed: 0 }),
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
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
  return {
    get: () => Promise.resolve(empty),
    refresh: () => Promise.resolve(empty),
    refreshCodexForTarget: () => Promise.resolve(empty),
    refreshClaudeForTarget: () => Promise.resolve(empty),
    setPollingInterval: () => Promise.resolve(),
    fetchInactiveClaudeAccounts: () => Promise.resolve(),
    fetchInactiveCodexAccounts: () => Promise.resolve(),
    onUpdate: () => noopUnsubscribe
  }
}

function createAccountsApi(): never {
  const empty = {
    accounts: [],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: {} }
  }
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
    openFilePath: () => Promise.resolve(false),
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
    pickRepoIconImage: () => Promise.resolve(null),
    pickAudio: () => Promise.resolve(null),
    pickDirectory: () => Promise.resolve(null),
    copyFile: () => Promise.resolve()
  }
}

function createPtyApi(): NonNullable<Partial<PreloadApi>['pty']> {
  return {
    spawn: () => Promise.reject(new Error('Local PTYs are unavailable in the web client.')),
    write: () => {},
    writeAccepted: () => Promise.resolve(false),
    resize: () => {},
    reportGeometry: () => {},
    signal: () => {},
    kill: () => Promise.resolve(),
    ackColdRestore: () => {},
    hasChildProcesses: () => Promise.resolve(false),
    getForegroundProcess: () => Promise.resolve(null),
    getCwd: () => Promise.resolve('~'),
    listSessions: () => Promise.resolve([]),
    getMainBufferSnapshot: () => Promise.resolve(null),
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
    resetRelay: () => Promise.resolve(),
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
  const response = await runtimeCallQueuePool.enqueue(environment.id, method, () =>
    getClientForEnvironment(environment).call(method, params, { timeoutMs })
  )
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
  const response = await runtimeCallQueuePool.enqueue(environment.id, method, () =>
    getClientForEnvironment(environment).call(method, params, { timeoutMs })
  )
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

async function saveClipboardImageAsTempFileInRuntime(
  contentBase64: string,
  args?: { connectionId?: string | null }
): Promise<string> {
  if (contentBase64.length > MAX_CLIPBOARD_IMAGE_BASE64_CHARS) {
    throw new Error('Clipboard image is too large')
  }
  const connectionId = args?.connectionId ?? null
  const startResponse = await callRuntimeEnvelope<{ uploadId: string }>(
    'clipboard.startImageUpload',
    { expectedBase64Length: contentBase64.length, connectionId },
    CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
  )
  if (!startResponse.ok) {
    if (
      startResponse.error.code === 'method_not_found' &&
      contentBase64.length <= CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS
    ) {
      return callRuntimeResult<string>(
        'clipboard.saveImageAsTempFile',
        { contentBase64, connectionId },
        CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
      )
    }
    throw new Error(startResponse.error.message)
  }

  const { uploadId } = startResponse.result
  try {
    for (
      let offset = 0;
      offset < contentBase64.length;
      offset += CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
    ) {
      await callRuntimeResult(
        'clipboard.appendImageUploadChunk',
        {
          uploadId,
          offset,
          contentBase64: contentBase64.slice(
            offset,
            offset + CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS
          )
        },
        CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
      )
    }
    return await callRuntimeResult<string>(
      'clipboard.commitImageUpload',
      { uploadId },
      CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
    )
  } catch (error) {
    // Why: once chunked paste has created server-side state, failed append or
    // commit must not wait for TTL cleanup before releasing the bounded slot.
    await callRuntimeResult(
      'clipboard.abortImageUpload',
      { uploadId },
      CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS
    ).catch(() => {})
    throw error
  }
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
  invalidateRuntimeWorktreeCaches()
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
  if (selector.startsWith('web-') && environment.id.startsWith('web-')) {
    // Why: persisted terminal ids can outlive a web-client re-pair, which creates
    // a fresh web-* environment id even when it points at the same active server.
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

function getStoredWorkspaceSession(): WorkspaceSessionState {
  const localSession = sanitizeWebRuntimeWorkspaceSession(
    readJson(SESSION_STORAGE_KEY, getDefaultWorkspaceSession())
  )
  if (!requireActiveEnvironmentOrNull()) {
    return localSession
  }
  const ui = readLocalWebUIState()
  // Why: paired web clients mirror host session-tabs after startup. Replaying
  // browser-local terminal handles first creates stale remote PTYs and errors.
  return sanitizeWebRuntimeWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    activeRepoId: ui.lastActiveRepoId,
    activeWorktreeId: ui.lastActiveWorktreeId,
    lastVisitedAtByWorktreeId: localSession.lastVisitedAtByWorktreeId
  })
}

function closeWebOnboarding(base: OnboardingState): OnboardingState {
  return {
    ...base,
    flowVersion: ONBOARDING_FLOW_VERSION,
    closedAt: Date.now(),
    outcome: 'dismissed',
    checklist: {
      ...base.checklist,
      dismissed: true
    }
  }
}

function readLocalWebUIState(): PersistedUIState {
  const defaults = getDefaultUIState()
  const stored = readJson<Partial<PersistedUIState>>(UI_STORAGE_KEY, {})
  if (typeof stored.rightSidebarOpen === 'boolean') {
    return mergeWebUIState(defaults, stored)
  }
  const storedSettings = getStoredSettings()
  return mergeWebUIState(defaults, {
    ...stored,
    // Why: web fallback lacks main-process normalization, so migrate the
    // retired setting only when the local UI preference is still absent.
    rightSidebarOpen: storedSettings.rightSidebarOpenByDefault
  })
}

function mergeWebUIState(
  base: PersistedUIState,
  updates: Partial<PersistedUIState>
): PersistedUIState {
  return {
    ...base,
    ...updates,
    agentActivityDisplayMode: normalizeAgentActivityDisplayMode(
      updates.agentActivityDisplayMode ?? base.agentActivityDisplayMode
    )
  }
}

function mergeFeatureInteractionState(
  current: PersistedUIState['featureInteractions'],
  incoming: PersistedUIState['featureInteractions']
): FeatureInteractionState {
  const currentNormalized = normalizeFeatureInteractions(current)
  const incomingNormalized = normalizeFeatureInteractions(incoming)
  const merged: FeatureInteractionState = { ...currentNormalized }
  for (const [id, incomingRecord] of Object.entries(incomingNormalized)) {
    const featureId = id as FeatureInteractionId
    const currentRecord = currentNormalized[featureId]
    merged[featureId] = currentRecord
      ? {
          firstInteractedAt: Math.min(
            currentRecord.firstInteractedAt,
            incomingRecord.firstInteractedAt
          ),
          interactionCount: Math.max(
            currentRecord.interactionCount,
            incomingRecord.interactionCount
          )
        }
      : incomingRecord
  }
  return merged
}

function mergeContextualTourSeenIds(
  current: PersistedUIState['contextualToursSeenIds'],
  incoming: PersistedUIState['contextualToursSeenIds']
): ContextualTourId[] {
  const merged = new Set<ContextualTourId>(normalizeContextualTourIds(current))
  for (const id of normalizeContextualTourIds(incoming)) {
    merged.add(id)
  }
  return [...merged]
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
    disabledTuiAgents: normalizeDisabledTuiAgents(
      updates.disabledTuiAgents ?? base.disabledTuiAgents
    ),
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
  const result = await callRuntimeResult<{ worktrees: Worktree[] }>('worktree.list', {
    limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT
  })
  cachedWorktrees = { loadedAt: Date.now(), worktrees: result.worktrees }
  return result.worktrees
}

async function listAllRuntimeDetectedWorktrees(): Promise<Worktree[]> {
  if (cachedDetectedWorktrees && Date.now() - cachedDetectedWorktrees.loadedAt < 5_000) {
    return cachedDetectedWorktrees.worktrees
  }

  const repos = (await callRuntimeResult<{ repos: Repo[] }>('repo.list')).repos
  const detectedLists = await Promise.all(
    repos.map((repo) => callRuntimeDetectedWorktrees(repo.id))
  )
  const worktrees = detectedLists.flatMap((result) => result.worktrees)
  cachedDetectedWorktrees = { loadedAt: Date.now(), worktrees }
  return worktrees
}

async function callRuntimeDetectedWorktrees(repoId: string): Promise<DetectedWorktreeListResult> {
  const response = await callRuntimeEnvelope<DetectedWorktreeListResult>(
    'worktree.detectedList',
    { repo: repoId },
    15_000
  )
  if (response.ok) {
    return response.result
  }
  if (response.error.code !== 'method_not_found') {
    throw new Error(response.error.message)
  }

  const legacy = await callRuntimeResult<{ worktrees: Worktree[] }>(
    'worktree.list',
    { repo: repoId, limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT },
    15_000
  )
  return toLegacyDetectedWorktreeResult(repoId, legacy.worktrees)
}

function toLegacyDetectedWorktreeResult(
  repoId: string,
  worktrees: Worktree[]
): DetectedWorktreeListResult {
  return {
    repoId,
    authoritative: true,
    source: 'session-fallback',
    worktrees: worktrees.map((worktree) => ({
      ...worktree,
      ownership: 'orca-managed',
      selectedCheckout: false,
      visible: true
    }))
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return /\bENOENT\b|not found|no such file/i.test(error.message)
}

async function resolveRuntimeWorktreeByPath(worktreePath: string): Promise<Worktree> {
  // Why: hidden-but-open worktrees must still resolve for git/file operations.
  // `worktree.list` is sidebar-visible only, so path resolution uses detected rows.
  const worktrees = await listAllRuntimeDetectedWorktrees()
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
  const repoId = typeof record.repoId === 'string' && record.repoId.trim() ? record.repoId : null
  return {
    ...record,
    // Why: runtime repo selectors accept loose path/name forms, but duplicate
    // checked-out repos can make those ambiguous. The renderer already passes
    // Orca's repo id on task calls, so prefer the explicit selector.
    repo: repoId ? `id:${repoId}` : record.repoPath
  }
}

function mapRuntimeNamespaceArg(prefix: string, args: unknown): unknown {
  if (prefix !== 'hostedReview') {
    return args
  }
  return mapRepoPathArg(args)
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
