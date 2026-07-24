/* eslint-disable max-lines -- Why: browser-side Electron-preload replacement; compatibility surface centralizes here. */
import type {
  PreloadApi,
  PreflightStatus,
  RefreshAgentsResult,
  NativeChatApi,
  NativeChatAppendedMessages
} from '../../../preload/api-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { AiVaultListArgs, AiVaultListResult } from '../../../shared/ai-vault-types'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../../shared/ai-vault-resume-preparation'
import { buildNativeChatUnsubscribe } from '../../../shared/native-chat-stream-unsubscribe'
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
  WorkspaceLineage,
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/types'
import type { SkillDiscoveryResult } from '../../../shared/skills'
import type { SkillFreshnessInventory } from '../../../shared/skill-freshness'
import type { SshConnectionState, SshTarget } from '../../../shared/ssh-types'
import {
  getDefaultOnboardingState,
  getDefaultSettings,
  getDefaultUIState,
  getDefaultWorkspaceSession,
  getWorktreeCardModeProperties,
  normalizeAgentActivityDisplayMode,
  normalizeWorktreeCardProperties,
  ONBOARDING_FLOW_VERSION
} from '../../../shared/constants'
import {
  createDefaultLocalOrcaProfile,
  DEFAULT_LOCAL_ORCA_PROFILE_ID
} from '../../../shared/orca-profiles'
import { legacyBaseRefSearchResult } from '../../../shared/base-ref-search-result'
import { EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS } from '../../../shared/pty-delivery-diagnostics'
import { createE2EConfig } from '../../../shared/e2e-config'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import {
  applyPRBotAuthorOverride,
  normalizePRBotAuthorOverrides
} from '../../../shared/pr-bot-author-overrides'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostScope,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { toRuntimeWorktreeSelector } from '../runtime/runtime-worktree-selector'
import { callAbortableRuntimeEnvironment } from '../runtime/abortable-runtime-environment-call'
import { normalizeDisabledTuiAgents } from '../../../shared/tui-agent-selection'
import {
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord
} from '../../../shared/tui-agent-launch-defaults'
import { normalizeAutoRenameBranchFromWorkDefaultOn } from '../../../shared/auto-rename-branch-from-work-settings'
import { normalizeTerminalCursorStyleDefault } from '../../../shared/terminal-cursor-style-settings'
import { normalizeTerminalCustomThemes } from '../../../shared/terminal-custom-themes'
import { normalizeUiLanguage } from '../../../shared/ui-language'
import { normalizeUsagePercentageDisplay } from '../../../shared/usage-percentage-display'
import { normalizeStatusBarUsageMode } from '../../../shared/status-bar-usage-mode'
import type { RateLimitState } from '../../../shared/rate-limit-types'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../../../shared/runtime-types'
import { assertFileMutationOwnershipCapability } from '../../../shared/file-mutation-ownership'
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
import { parseWebLocalStorageJson, stringifyWebLocalStorageJson } from './web-local-storage-json'
import { RuntimeRpcCallQueuePool } from '../../../shared/runtime-rpc-call-queue'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'
import {
  assertClipboardTextWriteWithinLimitWithYield,
  assertClipboardTextWithinLimitWithYield,
  type ReadClipboardTextOptions
} from '../../../shared/clipboard-text'
import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR,
  assertClipboardImageByteLengthWithinLimit,
  assertClipboardImageDimensionsWithinLimit
} from '../../../shared/clipboard-image'
import { sanitizeWebRuntimeWorkspaceSession } from './web-workspace-session'
import { WebPreloadRequestOwners } from './web-preload-request-owners'
import {
  normalizeFeatureInteractions,
  type FeatureInteractionId,
  type FeatureInteractionState
} from '../../../shared/feature-interactions'
import { normalizeContextualTourIds, type ContextualTourId } from '../../../shared/contextual-tours'
import { translate } from '@/i18n/i18n'
import { getDefaultCreateProjectParent } from '@/components/sidebar/create-project-defaults'
import {
  parseRuntimeNativeChatReadSessionResult,
  parseRuntimeNativeChatTurnLifecycle
} from '@/components/native-chat/native-chat-runtime-contract'
import { createWebFileMutationMethods } from './web-file-mutation-methods'

const SETTINGS_STORAGE_KEY = 'orca.web.settings.v1'
const UI_STORAGE_KEY = 'orca.web.ui.v1'
const SESSION_STORAGE_KEY = 'orca.web.workspaceSession.v1'
const ONBOARDING_STORAGE_KEY = 'orca.web.onboarding.v1'
const GITHUB_CACHE_STORAGE_KEY = 'orca.web.githubCache.v1'
const KEYBINDINGS_STORAGE_KEY = 'orca.web.keybindings.v1'
// Why: paired clients need parity for large dev sessions; the runtime default stays capped for lower-level RPC callers.
const WEB_RUNTIME_WORKTREE_LIST_LIMIT = 10_000
export const WEB_RUNTIME_REPO_DISCOVERY_CONCURRENCY = 8
const MAX_CLIPBOARD_IMAGE_BASE64_CHARS = CLIPBOARD_IMAGE_MAX_BASE64_CHARS
export const MAX_CLIPBOARD_IMAGE_SOURCE_BYTES = CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
export const MAX_CLIPBOARD_IMAGE_PIXELS = CLIPBOARD_IMAGE_MAX_PIXELS
export const CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024
export const CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS = 256 * 1024
const CLIPBOARD_IMAGE_SAVE_TIMEOUT_MS = 30_000
export const WEB_PRELOAD_MAX_KEYBINDING_LISTENERS = 64

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

function assertClipboardImageBlobWithinLimit(blob: Blob): void {
  assertClipboardImageByteLengthWithinLimit(blob.size)
}

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  assertClipboardImageBlobWithinLimit(blob)
  const bitmap = await createImageBitmap(blob)
  try {
    assertClipboardImageDimensionsWithinLimit(bitmap)
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
        try {
          assertClipboardImageBlobWithinLimit(png)
        } catch (error) {
          reject(error)
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
    assertClipboardImageBlobWithinLimit(blob)
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
type WebRuntimeResultCaller = <TResult>(
  method: string,
  params?: unknown,
  timeoutMs?: number
) => Promise<TResult>
type WebRuntimeEnvelopeCaller = <TResult>(
  method: string,
  params?: unknown,
  timeoutMs?: number
) => Promise<RuntimeRpcResponse<TResult>>
type WebGitHubRouteKey =
  | 'repoSlug'
  | 'repoUpstream'
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
  | 'github.repoUpstream'
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
  repoUpstream: 'github.repoUpstream',
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
type WebKeybindingSubscription = {
  target: Window
  onStorage: (event: StorageEvent) => void
}
const webKeybindingSubscriptions = new Map<
  (snapshot: KeybindingFileSnapshot) => void,
  WebKeybindingSubscription
>()

export function installWebPreloadApi(): void {
  disposeWebPreloadOwnedState()
  activeEnvironment = readStoredWebRuntimeEnvironment()
  const webWindow = window as unknown as { __ORCA_WEB_CLIENT__?: boolean }
  webWindow.__ORCA_WEB_CLIENT__ = true
  window.electron = createFallbackProxy(['electron']) as Window['electron']
  window.api = withFallback(createWebPreloadApi(), []) as PreloadApi
}

function createWebPreloadApi(): Partial<PreloadApi> {
  const webOrcaProfileAuthStatus = () =>
    Promise.resolve({
      activeProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
      configured: false,
      state: 'unconfigured' as const,
      persistence: 'none' as const,
      setupMessage: 'Orca Cloud sign-in is not available in the browser fallback.'
    })

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
      persistBeforeUnloadSync: ({ sessions, ui }) => {
        // Why: beforeunload cannot await the paired runtime, so the web adapter
        // guarantees immediate browser-local durability for the final snapshot.
        for (const { state, hostId } of sessions) {
          writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(state))
        }
        writeJson(UI_STORAGE_KEY, mergeWebUIState(readLocalWebUIState(), ui))
      },
      awaitFirstWindowStartupServices: () => Promise.resolve(),
      startupDiagnostic: () => Promise.resolve(),
      getKeyboardInputSourceId: () => Promise.resolve(null),
      setUnreadDockBadgeCount: () => Promise.resolve(),
      getFloatingTerminalCwd: () => Promise.resolve(''),
      getFloatingMarkdownDirectory: () => Promise.resolve(''),
      pickFloatingMarkdownDocument: () => Promise.resolve(null),
      pickFloatingWorkspaceDirectory: () => Promise.resolve(null),
      // Browser fallback has no app-owned userData dir; reject so the sentinel can't claim sensitive evidence was persisted.
      writeTerminalRenderDesyncEvidence: () =>
        Promise.reject(
          new Error('Terminal render evidence is unavailable in the browser fallback.')
        )
    },
    starNag: {
      onShow: () => noopUnsubscribe,
      onHide: () => noopUnsubscribe,
      dismiss: () => Promise.resolve(),
      later: () => Promise.resolve(),
      complete: () => Promise.resolve(),
      disable: () => Promise.resolve(),
      openWeb: () => Promise.resolve(),
      starOrca: () => Promise.resolve(false),
      forceShow: () => Promise.resolve(),
      agentValueMoment: () => Promise.resolve({ status: 'skipped' }),
      showAgentValueMoment: () => Promise.resolve(),
      onboardingCompleted: () => Promise.resolve()
    },
    platform: {
      get: () => ({
        platform: getBrowserPlatform(),
        osRelease: '',
        displayServer: null
      })
    },
    workspacePorts: {
      // Why: browser-local workspaces have no host process to inspect; return capability state instead of the generic undefined fallback.
      scan: () =>
        Promise.resolve({
          platform: getBrowserPlatform(),
          scannedAt: Date.now(),
          ports: [],
          unavailableReason: 'Workspace port scanning is unavailable for browser-local workspaces.'
        }),
      kill: () =>
        Promise.resolve({
          ok: false,
          reason: 'Workspace port management is unavailable for browser-local workspaces.'
        }),
      onAdvertisedUrlChanged: () => noopUnsubscribe
    },
    orcaProfiles: {
      list: () =>
        Promise.resolve({
          activeProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
          profiles: [createDefaultLocalOrcaProfile(0)],
          multiProfileUi: false
        }),
      authStatus: webOrcaProfileAuthStatus,
      createLocal: () =>
        Promise.resolve({
          activeProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
          profiles: [createDefaultLocalOrcaProfile(0)],
          profile: createDefaultLocalOrcaProfile(0)
        }),
      createCloudLinked: async () => ({
        status: 'unconfigured',
        auth: await webOrcaProfileAuthStatus()
      }),
      switchProfile: () => Promise.resolve({ status: 'already-active' }),
      transferProject: (args) =>
        Promise.resolve({
          status: 'duplicate-target',
          sourceProfileId: args.sourceProfileId,
          targetProfileId: args.targetProfileId,
          sourceRepoId: args.repoId,
          duplicateRepoId: args.repoId
        }),
      findProjectProfiles: async () => ({ projects: [] }),
      connectCurrent: async () => ({
        status: 'unconfigured',
        auth: await webOrcaProfileAuthStatus()
      }),
      refreshAuth: async () => ({
        status: 'unconfigured',
        auth: await webOrcaProfileAuthStatus()
      }),
      signOutCurrent: async () => ({
        status: 'signed-out',
        auth: await webOrcaProfileAuthStatus(),
        activeProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
        profiles: [createDefaultLocalOrcaProfile(0)]
      }),
      selectOrg: async () => ({
        status: 'unconfigured',
        auth: await webOrcaProfileAuthStatus()
      }),
      orgMembersList: async () => ({ status: 'unconfigured' }),
      orgMemberInvite: async () => ({ status: 'unconfigured' }),
      orgInviteRevoke: async () => ({ status: 'unconfigured' }),
      orgMemberChangeRole: async () => ({ status: 'unconfigured' }),
      orgMemberRemove: async () => ({ status: 'unconfigured' })
    },
    e2e: {
      getConfig: () => createE2EConfig({})
    },
    settings: {
      get: async () => getRuntimeBackedStoredSettings(),
      // Why: localStorage-backed settings are synchronous, so the pre-hydration kill-switch read works the same as desktop.
      getSync: () => getStoredSettings(),
      set: async (updates) => {
        const sanitizedUpdates = { ...updates }
        delete sanitizedUpdates.activeRuntimeEnvironmentId
        if ('autoRenameBranchFromWorkDefaultedOn' in sanitizedUpdates) {
          sanitizedUpdates.autoRenameBranchFromWorkDefaultedOn = true
        }
        const next = mergeSettings(getStoredSettings(), sanitizedUpdates, {
          preserveAutoRenameBranchFromWorkUpdate: 'autoRenameBranchFromWork' in sanitizedUpdates
        })
        writeStoredSettings(next)
        return syncRuntimeBackedSettings(sanitizedUpdates, next)
      },
      setActiveRuntimeEnvironmentPreference: async ({ environmentId }) => {
        const requestedEnvironmentId = environmentId?.trim() || null
        const activeRuntimeEnvironmentId = requestedEnvironmentId
          ? resolveEnvironment(requestedEnvironmentId).id
          : null
        const next = mergeSettings(getStoredSettings(), {
          activeRuntimeEnvironmentId
        })
        writeStoredSettings(next, activeRuntimeEnvironmentId)
        return next
      },
      updatePRBotAuthorOverride: (args) => updateRuntimePRBotAuthorOverride(args),
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
          error: translate('auto.web.web.preload.api.fb290366b2', 'Unavailable on web.')
        }),
      copyLatestDiagnostics: () =>
        Promise.resolve({
          ok: false,
          error: translate('auto.web.web.preload.api.fb290366b2', 'Unavailable on web.')
        })
    },
    diagnostics: {
      getStatus: () =>
        Promise.resolve({
          localFileEnabled: false,
          bundleEnabled: false,
          traceFilePath: '',
          traceFamilySize: 0
        }),
      collectBundle: () => Promise.reject(new Error('Review files are unavailable on web.')),
      openBundlePreview: () => Promise.reject(new Error('Review files are unavailable on web.')),
      discardBundlePreview: () => Promise.resolve(),
      uploadBundle: () => Promise.reject(new Error('Sending diagnostics is unavailable on web.')),
      deleteBundle: () => Promise.reject(new Error('Sent diagnostics are unavailable on web.'))
    },
    session: {
      // Mirrors desktop bridge: non-local hosts persist under a host-suffixed key so their sessions stay isolated from local.
      get: (hostId) => Promise.resolve(getStoredWorkspaceSession(hostId)),
      set: async (session, hostId) => {
        writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session))
      },
      patch: async (patch: WorkspaceSessionPatch, hostId) => {
        writeJson(
          sessionStorageKeyForHost(hostId),
          sanitizeWebRuntimeWorkspaceSession({
            ...getStoredWorkspaceSession(hostId),
            ...patch
          })
        )
      },
      // localStorage writes synchronously, so there is no deferred web flush.
      flush: async () => {},
      readTerminalScrollback: () => null,
      setSync: (session, hostId) => {
        writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session))
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
    nativeChat: createNativeChatApi(),
    runtimeEnvironments: createRuntimeEnvironmentsApi(),
    repos: createReposApi(),
    worktrees: createWorktreesApi(),
    fs: createFileApi(),
    git: createGitApi(),
    browser: createBrowserApi(),
    emulator: createEmulatorApi(),
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
    aiVault: createAiVaultApi(),
    preflight: createPreflightApi(),
    notifications: createNotificationsApi(),
    rateLimits: createRateLimitsApi(),
    minimaxCredentials: createMiniMaxCredentialsApi(),
    grokAccounts: createGrokAccountsApi(),
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
      onClear: () => noopUnsubscribe,
      getSnapshot: () => Promise.resolve([]),
      inferInterrupt: () => Promise.resolve(false),
      inferQuestionAnswered: () => Promise.resolve(false),
      onMigrationUnsupported: () => noopUnsubscribe,
      onMigrationUnsupportedClear: () => noopUnsubscribe,
      getMigrationUnsupportedSnapshot: () => Promise.resolve([]),
      drop: () => {},
      dropByTabPrefix: () => {},
      retirePaneAuthority: () => {},
      transferPaneAuthority: () => {}
    },
    mobile: {
      listNetworkInterfaces: () => Promise.resolve({ interfaces: [] }),
      getPairingQR: () => Promise.resolve({ available: false }),
      getWindowsFirewallStatus: () => Promise.resolve({ supported: false }),
      repairWindowsFirewall: () => Promise.resolve({ ok: false, reason: 'unsupported' }),
      openWindowsNetworkSettings: () => Promise.resolve(false),
      getRuntimePairingUrl: () => Promise.resolve({ available: false }),
      listDevices: () => Promise.resolve({ devices: [] }),
      revokeDevice: () => Promise.resolve({ revoked: false }),
      listRuntimeAccessGrants: () => Promise.resolve({ grants: [] }),
      revokeRuntimeAccess: () => Promise.resolve({ revoked: false }),
      isWebSocketReady: () =>
        Promise.resolve({ ready: Boolean(activeEnvironment), endpoint: null }),
      getRelayStatus: () => Promise.resolve({ status: 'offline' as const }),
      onRelayStatusChanged: () => noopUnsubscribe,
      consumePendingUnpairedDeviceAuthFailure: () => Promise.resolve(false),
      onUnpairedDeviceAuthFailure: () => noopUnsubscribe
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
    diagnostics.push({
      severity: 'error',
      section,
      message: translate('auto.web.web.preload.api.d2e43e426a', '{{value0}} must be an object.', {
        value0: section
      })
    })
    return {}
  }

  const overrides: KeybindingOverrides = {}
  for (const [actionId, rawBindings] of Object.entries(value)) {
    if (!isKeybindingActionId(actionId)) {
      diagnostics.push({
        severity: 'warning',
        section,
        actionId,
        message: translate(
          'auto.web.web.preload.api.36761d9604',
          'Unknown keybinding action "{{value0}}" was ignored.',
          { value0: actionId }
        )
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
        message: translate(
          'auto.web.web.preload.api.10898045f3',
          'Shortcut for "{{value0}}" was ignored: Use a string array.',
          { value0: actionId }
        )
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
        message: translate(
          'auto.web.web.preload.api.76122208ca',
          'Shortcut for "{{value0}}" was ignored: {{value1}}',
          { value0: actionId, value1: error }
        )
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
      message: translate(
        'auto.web.web.preload.api.0a69fcd8bc',
        'platforms must be an object with darwin, linux, or win32 sections.'
      )
    })
    return {}
  }

  const result: Partial<Record<KeybindingPlatform, KeybindingOverrides>> = {}
  for (const [platform, overrides] of Object.entries(value)) {
    if (!WEB_KEYBINDING_PLATFORMS.includes(platform as KeybindingPlatform)) {
      diagnostics.push({
        severity: 'warning',
        section: `platforms.${platform}`,
        message: translate(
          'auto.web.web.preload.api.32f15bdb0f',
          'Unknown platform "{{value0}}" was ignored.',
          { value0: platform }
        )
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
      message: translate(
        'auto.web.web.preload.api.52bee9d8a0',
        'Conflicting custom shortcuts were ignored: {{value0}}.',
        {
          value0: Array.from(conflictingOverrides)
            .map((actionId) => actionId)
            .join(', ')
        }
      )
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
  for (const listener of webKeybindingSubscriptions.keys()) {
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
      const existing = webKeybindingSubscriptions.get(callback)
      if (existing) {
        return () => releaseWebKeybindingSubscription(callback, existing)
      }
      if (webKeybindingSubscriptions.size >= WEB_PRELOAD_MAX_KEYBINDING_LISTENERS) {
        throw new Error('Web keybinding listener capacity reached; remove a listener and retry.')
      }
      const target = window
      const onStorage = (event: StorageEvent): void => {
        if (event.key === KEYBINDINGS_STORAGE_KEY) {
          callback(getWebKeybindingSnapshot())
        }
      }
      const subscription = { target, onStorage }
      webKeybindingSubscriptions.set(callback, subscription)
      target.addEventListener('storage', onStorage)
      return () => releaseWebKeybindingSubscription(callback, subscription)
    }
  }
}

function releaseWebKeybindingSubscription(
  callback: (snapshot: KeybindingFileSnapshot) => void,
  expected: WebKeybindingSubscription
): void {
  if (webKeybindingSubscriptions.get(callback) !== expected) {
    return
  }
  webKeybindingSubscriptions.delete(callback)
  expected.target.removeEventListener('storage', expected.onStorage)
}

function disposeWebKeybindingSubscriptions(): void {
  for (const [callback, subscription] of webKeybindingSubscriptions) {
    releaseWebKeybindingSubscription(callback, subscription)
  }
}

// Why: web has no IPC for native-chat transcripts, so route readSession/subscribe through runtime RPC (as mobile does).
function createNativeChatApi(): NativeChatApi {
  return {
    readSession: async (agent, sessionId, limit, transcriptPath) =>
      parseRuntimeNativeChatReadSessionResult(
        await callRuntimeResult<unknown>('nativeChat.readSession', {
          agent,
          sessionId,
          limit,
          transcriptPath
        })
      ),
    subscribe: (args, onFrame) => {
      // No paired runtime yet: return a no-op teardown so the chat view mounts cleanly; only the not-paired case is swallowed.
      const environment = requireActiveEnvironmentOrNull()
      if (!environment) {
        onFrame({
          type: 'snapshot',
          messages: [],
          hasMore: false,
          error: translate(
            'components.native-chat.state.pairHost',
            'Pair a host to view agent chat history.'
          )
        })
        return () => {}
      }
      let handle: { unsubscribe: () => void } | null = null
      let cancelled = false
      let receivedInitial = false
      void getClientForEnvironment(environment)
        .subscribe(
          'nativeChat.subscribe',
          {
            agent: args.agent,
            sessionId: args.sessionId,
            subscriptionId: args.subscriptionId,
            transcriptPath: args.transcriptPath,
            limit: args.limit
          },
          {
            onResponse: (response) => {
              if (cancelled) {
                return
              }
              if (!response.ok) {
                if (!receivedInitial) {
                  receivedInitial = true
                  onFrame({
                    type: 'snapshot',
                    messages: [],
                    hasMore: false,
                    error: response.error.message
                  })
                }
                return
              }
              const result = response.result as {
                type?: string
                messages?: NativeChatAppendedMessages
                hasMore?: boolean
                error?: string
                lifecycle?: unknown
              }
              const lifecycle = parseRuntimeNativeChatTurnLifecycle(result?.lifecycle)
              if (
                (result?.type === 'appended' ||
                  result?.type === 'snapshot' ||
                  result?.type === 'replacement') &&
                Array.isArray(result.messages)
              ) {
                if (!receivedInitial) {
                  receivedInitial = true
                  onFrame({
                    type: 'snapshot',
                    messages: result.messages,
                    hasMore: result.hasMore ?? result.messages.length >= (args.limit ?? 300),
                    ...(result.error ? { error: result.error } : {}),
                    ...(lifecycle ? { lifecycle } : {})
                  })
                } else if (result.type === 'snapshot') {
                  onFrame({
                    type: 'snapshot',
                    messages: result.messages,
                    hasMore: result.hasMore ?? false,
                    ...(result.error ? { error: result.error } : {}),
                    ...(lifecycle ? { lifecycle } : {})
                  })
                } else {
                  onFrame(
                    result.type === 'replacement'
                      ? {
                          type: 'replacement',
                          messages: result.messages,
                          hasMore: result.hasMore ?? false,
                          ...(lifecycle ? { lifecycle } : {})
                        }
                      : {
                          type: 'appended',
                          messages: result.messages,
                          ...(lifecycle ? { lifecycle } : {})
                        }
                  )
                }
              } else if (!receivedInitial) {
                // Why: an unrecognized ok payload never flips receivedInitial, stranding the view on 'loading'; settle it empty instead.
                receivedInitial = true
                onFrame({
                  type: 'snapshot',
                  messages: [],
                  hasMore: false,
                  ...(result?.error ? { error: result.error } : {})
                })
              }
            }
          },
          {
            // Why: unsubscribe reaps the fs-watcher on view-toggle (leak fix); echo the pane token so two panes don't tear down each other's watcher.
            buildUnsubscribe: () =>
              buildNativeChatUnsubscribe(args.agent, args.sessionId, args.subscriptionId)
          }
        )
        .then((h) => {
          if (cancelled) {
            h.unsubscribe()
          } else {
            handle = h
          }
        })
        .catch((err: unknown) => {
          if (!cancelled && !receivedInitial) {
            receivedInitial = true
            onFrame({
              type: 'snapshot',
              messages: [],
              hasMore: false,
              error: err instanceof Error ? err.message : String(err)
            })
          }
        })
      return () => {
        cancelled = true
        handle?.unsubscribe()
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
      const previousEnvironment = activeEnvironment
      closeActiveRuntimeClients()
      activeEnvironment = createStoredWebRuntimeEnvironment({ name, offer, previousEnvironment })
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
    disconnect: async ({ selector }) => {
      const environment = resolveEnvironment(selector)
      if (activeEnvironment?.id === environment.id) {
        disconnectActiveRuntimeEnvironment()
      }
      return { disconnected: redactStoredWebRuntimeEnvironment(environment) }
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

function createAiVaultApi(): NonNullable<Partial<PreloadApi>['aiVault']> {
  return {
    listSessions: (args?: AiVaultListArgs) => {
      const environment = requireActiveEnvironment()
      const executionHostId = toRuntimeExecutionHostId(environment.id)
      const requestedScope = normalizeExecutionHostScope(
        args?.executionHostScope ?? executionHostId
      )
      if (requestedScope !== 'all' && requestedScope !== executionHostId) {
        return Promise.resolve(webAiVaultUnavailableResult(requestedScope))
      }
      // Why: no local filesystem in the browser, so every history scan runs on and is stamped as the paired runtime host.
      return callRuntimeResult<AiVaultListResult>('aiVault.listSessions', {
        limit: args?.limit,
        force: args?.force,
        scopePaths: args?.scopePaths,
        executionHostId
      })
    },
    prepareSessionResume: (args: AiVaultPrepareSessionResumeArgs) =>
      callRuntimeResult<AiVaultPrepareSessionResumeResult>('aiVault.prepareSessionResume', args),
    // Why: no server-side RPC for subagent transcript listing yet, so report an empty (not erroring) result.
    listSubagentSessions: () => Promise.resolve({ sessions: [], issues: [] }),
    onWindowFocused: () => noopUnsubscribe
  }
}

function webAiVaultUnavailableResult(executionHostId: ExecutionHostId): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        executionHostId,
        agent: 'codex',
        path: executionHostId,
        message: translate(
          'auto.web.webPreloadApi.aiVaultUnavailableForHost',
          'Agent Session History is not available for this execution host.'
        )
      }
    ],
    scannedAt: new Date().toISOString()
  }
}

function createReposApi(): NonNullable<Partial<PreloadApi>['repos']> {
  return {
    list: async () => {
      const owned = await callRuntimeResultWithOwner<{ repos: Repo[] }>('repo.list')
      return owned.result.repos.map((repo) => withRuntimeRepoOwner(repo, owned.hostId))
    },
    add: async ({ path, kind }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo } | { error: string }>(
        'repo.add',
        { path, kind }
      )
      return withRuntimeRepoMutationOwner(owned.result, owned.hostId)
    },
    remove: async ({ repoId }) => {
      await callRuntimeResult('repo.rm', { repo: repoId })
      invalidateRuntimeWorktreeCaches()
    },
    // Why: host-scoped forget targets a desktop-owned SSH host; a paired web client has one runtime and no ghost-host state.
    removeForHost: () => {
      throw new Error('Forgetting a host is unavailable in paired web clients.')
    },
    reorder: async ({ orderedIds }) => callRuntimeResult('repo.reorder', { orderedIds }),
    // Why: this persists desktop-owned local/SSH rows; paired web clients own one runtime and use repo.reorder directly.
    reorderForHost: async () => {
      throw new Error('Host-scoped project reordering is unavailable in paired web clients.')
    },
    update: async ({ repoId, updates }) => {
      const owned = await callRuntimeResultWithOwner<{ repo: Repo }>('repo.update', {
        repo: repoId,
        updates
      })
      return withRuntimeRepoOwner(owned.result.repo, owned.hostId)
    },
    pickFolder: () => Promise.resolve(null),
    pickFolders: () => Promise.resolve([]),
    pickDirectory: () => Promise.resolve(null),
    clone: async ({ url, destination }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo }>(
        'repo.clone',
        { url, destination },
        10 * 60_000
      )
      return withRuntimeRepoOwner(owned.result.repo, owned.hostId)
    },
    cloneRemote: async () => {
      // Why: SSH relay cloning is owned by the desktop main process; paired web clients can't run that local IPC path.
      throw new Error('SSH clone is unavailable in paired web clients.')
    },
    createRemote: async () => {
      // Why: SSH relay project creation is owned by the desktop main process; paired web clients can't use local SSH IPC.
      throw new Error('Creating projects on SSH hosts is unavailable in paired web clients.')
    },
    cloneAbort: () => Promise.resolve(),
    addRemote: async ({ remotePath, displayName, kind }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo }>('repo.add', {
        path: remotePath,
        kind
      })
      const result = {
        repo: withRuntimeRepoOwner(owned.result.repo, owned.hostId)
      }
      if (!displayName) {
        return result
      }
      assertActiveEnvironment(owned.environmentId)
      return {
        repo: await createReposApi().update({
          repoId: result.repo.id,
          updates: { displayName }
        })
      }
    },
    create: async ({ parentPath, name, kind }) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ repo: Repo } | { error: string }>(
        'repo.create',
        { parentPath, name, kind }
      )
      return withRuntimeRepoMutationOwner(owned.result, owned.hostId)
    },
    isGitAvailable: async () =>
      (await callRuntimeResult<{ available: boolean }>('repo.gitAvailable')).available,
    getDefaultCreateProjectParent: async () => {
      const result = await callRuntimeResult<{ resolvedPath: string }>('files.browseServerDir', {
        path: '~'
      })
      return getDefaultCreateProjectParent(result.resolvedPath)
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
    list: async ({ repoId }) => {
      const owned = await callRuntimeResultWithOwner<{ worktrees: Worktree[] }>('worktree.list', {
        repo: repoId,
        limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT
      })
      return owned.result.worktrees.map((worktree) =>
        withRuntimeWorktreeOwner(worktree, owned.hostId)
      )
    },
    listDetected: async ({ repoId }) => callRuntimeDetectedWorktrees(repoId),
    listAll: () => listAllRuntimeWorktrees(),
    create: async (args) => {
      invalidateRuntimeWorktreeCaches()
      const owned = await callRuntimeResultWithOwner<{ worktree: Worktree }>('worktree.create', {
        repo: args.repoId,
        name: args.name,
        baseBranch: args.baseBranch,
        compareBaseRef: args.compareBaseRef,
        branchNameOverride: args.branchNameOverride,
        linkedIssue: args.linkedIssue,
        linkedPR: args.linkedPR,
        linkedLinearIssue: args.linkedLinearIssue,
        linkedLinearIssueWorkspaceId: args.linkedLinearIssueWorkspaceId,
        linkedLinearIssueOrganizationUrlKey: args.linkedLinearIssueOrganizationUrlKey,
        linkedGitLabIssue: args.linkedGitLabIssue,
        linkedGitLabMR: args.linkedGitLabMR,
        linkedBitbucketPR: args.linkedBitbucketPR,
        linkedAzureDevOpsPR: args.linkedAzureDevOpsPR,
        linkedGiteaPR: args.linkedGiteaPR,
        displayName: args.displayName,
        sparseCheckout: args.sparseCheckout,
        pushTarget: args.pushTarget,
        setupDecision: args.setupDecision,
        createdWithAgent: args.createdWithAgent,
        pendingFirstAgentMessageRename: args.pendingFirstAgentMessageRename,
        ...(args.startup
          ? {
              startupCommand: args.startup.command,
              ...(args.startup.env ? { startupEnv: args.startup.env } : {}),
              ...(args.startup.launchConfig
                ? { startupLaunchConfig: args.startup.launchConfig }
                : {}),
              ...(args.startup.startupCommandDelivery
                ? { startupCommandDelivery: args.startup.startupCommandDelivery }
                : {}),
              activate: true
            }
          : {}),
        parentWorkspace: args.parentWorkspace,
        workspaceStatus: args.workspaceStatus,
        manualOrder: args.manualOrder,
        automationProvenanceRequest: args.automationProvenanceRequest
      })
      return {
        ...owned.result,
        worktree: withRuntimeWorktreeOwner(owned.result.worktree, owned.hostId)
      }
    },
    // Why: the runtime create path emits no two-phase progress, so the panel falls back to an indeterminate spinner.
    onCreateProgress: () => noopUnsubscribe,
    prefetchCreateBase: async ({ repoId, baseBranch }) => {
      await callRuntimeResult('worktree.prefetchCreateBase', {
        repo: repoId,
        baseBranch
      })
    },
    resolvePrBase: async ({ repoId, prNumber, headRefName, baseRefName, isCrossRepository }) =>
      callRuntimeResult('worktree.resolvePrBase', {
        repo: repoId,
        prNumber,
        headRefName,
        baseRefName,
        isCrossRepository
      }),
    resolveMrBase: async ({ repoId, mrIid, sourceBranch, targetBranch, isCrossRepository }) =>
      callRuntimeResult('worktree.resolveMrBase', {
        repo: repoId,
        mrIid,
        sourceBranch,
        targetBranch,
        isCrossRepository
      }),
    remove: async ({ worktreeId, force, skipArchive }) => {
      invalidateRuntimeWorktreeCaches()
      return callRuntimeResult<RemoveWorktreeResult>('worktree.rm', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        force,
        runHooks: skipArchive !== true
      })
    },
    // Why: forget-locally clears a desktop workspace pinned to a dead SSH host; a paired web client has no such ghost state.
    forgetLocal: () => {
      throw new Error('Forgetting a workspace is unavailable in paired web clients.')
    },
    forceDeletePreservedBranch: ({ worktreeId, branchName, expectedHead }) =>
      callRuntimeResult<ForceDeleteWorktreeBranchResult>('worktree.forceDeleteBranch', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        branchName,
        expectedHead
      }),
    updateMeta: async ({ worktreeId, updates }) => {
      const rpcUpdates =
        Object.prototype.hasOwnProperty.call(updates, 'pushTarget') &&
        updates.pushTarget === undefined
          ? { ...updates, pushTarget: null }
          : updates
      const owned = await callRuntimeResultWithOwner<{ worktree: Worktree }>('worktree.set', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        ...rpcUpdates
      })
      return withRuntimeWorktreeOwner(owned.result.worktree, owned.hostId)
    },
    listLineage: async () =>
      await callRuntimeResult<{
        lineage: Record<string, WorktreeLineage>
        workspaceLineage?: Record<string, WorkspaceLineage>
      }>('worktree.lineageList'),
    updateLineage: async ({ worktreeId, parentWorktreeId, noParent }) => {
      invalidateRuntimeWorktreeCaches()
      const result = await callRuntimeResult<{
        worktree: Worktree & { lineage?: WorktreeLineage | null }
      }>('worktree.set', {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        parentWorktree: parentWorktreeId,
        noParent
      })
      return result.worktree.lineage ?? null
    },
    persistSortOrder: async ({ orderedIds }) => {
      await callRuntimeResult('worktree.persistSortOrder', { orderedIds })
    },
    // Why: the capture lives in desktop main memory, unexposed over pairing; the dialog falls back to the persisted excerpt.
    getBranchRenameFailureOutput: async () => null,
    onChanged: () => noopUnsubscribe,
    onGitStatusMetadataChanged: () => noopUnsubscribe,
    onHeadIdentitiesChanged: () => noopUnsubscribe,
    onBaseStatus: () => noopUnsubscribe,
    onRemoteBranchConflict: () => noopUnsubscribe
  }
}

function createFileApi(): NonNullable<Partial<PreloadApi>['fs']> {
  return {
    readDir: async ({ dirPath }) => {
      const file = await resolveRuntimeFilePath(dirPath)
      return callRuntimeResult<DirEntry[]>('files.readDir', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    readFile: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.readPreview', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    readLocalLogTail: async () => {
      throw new Error('Local log tailing is unavailable in paired web clients.')
    },
    startLocalLogTail: async () => {
      throw new Error('Local log tailing is unavailable in paired web clients.')
    },
    stopLocalLogTail: async () => {},
    onLocalLogTailChanged: () => noopUnsubscribe,
    downloadFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    downloadFolder: async () => {
      throw new Error('Remote folder download is unavailable in paired web clients.')
    },
    saveDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    startDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    appendDownloadedFileChunk: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    finishDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    cancelDownloadedFile: async () => {
      throw new Error('Remote file download is unavailable in paired web clients.')
    },
    listMarkdownDocuments: async ({ rootPath }) => {
      const file = await resolveRuntimeFilePath(rootPath)
      return callRuntimeResult('files.listMarkdownDocuments', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id)
      })
    },
    ...createWebFileMutationMethods({
      captureSession: captureWebFileMutationSession
    }),
    authorizeExternalPath: () => Promise.resolve(),
    stat: async ({ filePath }) => {
      const file = await resolveRuntimeFilePath(filePath)
      return callRuntimeResult('files.stat', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        relativePath: file.relativePath
      })
    },
    pathExists: async ({ filePath }) => {
      try {
        const file = await resolveRuntimeFilePath(filePath)
        await callRuntimeResult('files.stat', {
          worktree: toRuntimeWorktreeSelector(file.worktree.id),
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
          worktree: toRuntimeWorktreeSelector(file.worktree.id),
          excludePaths
        }
      )
      return result.files.map((entry) => entry.relativePath)
    },
    cancelListFiles: async () => {
      // Why: paired-web lists files over runtime RPC with its own timeout; there's no host-side scan to abort here.
    },
    search: async (args) => {
      const file = await resolveRuntimeFilePath(args.rootPath)
      return callRuntimeResult<SearchResult>('files.search', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
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

// Why: track the in-flight abortable status request per token so cancelStatus can abort it and close its remote context.
const webGitStatusRequestOwners = new WebPreloadRequestOwners()

async function callAbortableRuntimeStatus<TResult>(
  requestToken: string,
  params: unknown
): Promise<TResult> {
  const environment = requireActiveEnvironment()
  const controller = webGitStatusRequestOwners.replace(requestToken)
  try {
    const response = await callAbortableRuntimeEnvironment(
      environment.id,
      'git.status',
      params,
      undefined,
      controller.signal
    )
    updateEnvironmentFromResponse(environment, response)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result as TResult
  } finally {
    webGitStatusRequestOwners.release(requestToken, controller)
  }
}

function createGitApi(): NonNullable<Partial<PreloadApi>['git']> {
  return {
    status: async ({
      worktreePath,
      includeIgnored,
      bypassEffectiveUpstreamNegativeCache,
      reuseLineStats,
      requestToken
    }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      const params = {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        includeIgnored,
        bypassEffectiveUpstreamNegativeCache,
        reuseLineStats
      }
      // Why: no token = nothing to cancel (pooled); a token routes via the subscription bridge so cancelStatus can abort.
      if (!requestToken) {
        return callRuntimeResult('git.status', params)
      }
      return callAbortableRuntimeStatus(requestToken, params)
    },
    cancelStatus: async ({ requestToken }) => {
      webGitStatusRequestOwners.abort(requestToken)
    },
    submoduleStatus: async ({ worktreePath, submodulePath, area }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.submoduleStatus', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        submodulePath,
        area
      })
    },
    checkIgnored: async ({ worktreePath, paths }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.checkIgnored', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        paths
      })
    },
    // Why: the "add huge folder to .gitignore" flow is desktop-only; the web runtime makes no offer, so return no candidates.
    findHugeFoldersToIgnore: async () => [],
    appendGitignore: async () => false,
    history: async ({ worktreePath, limit, baseRef }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.history', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        limit,
        baseRef
      })
    },
    conflictOperation: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.conflictOperation', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    abortMerge: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.abortMerge', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    abortRebase: async ({ worktreePath }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.abortRebase', {
        worktree: toRuntimeWorktreeSelector(worktree.id)
      })
    },
    diff: async ({ worktreePath, filePath, staged, compareAgainstHead }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.diff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        staged,
        compareAgainstHead
      })
    },
    branchCompare: async ({ worktreePath, baseRef }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.branchCompare', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        baseRef
      })
    },
    commitCompare: async ({ worktreePath, commitId }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.commitCompare', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        commitId
      })
    },
    upstreamStatus: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.upstreamStatus', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    fetch: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.fetch', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    syncFork: async ({ worktreePath, expectedUpstream }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult(
        'git.forkSync',
        {
          worktree: toRuntimeWorktreeSelector(worktree.id),
          expectedUpstream
        },
        60_000
      )
    },
    push: async ({ worktreePath, publish, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.push', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        publish,
        pushTarget
      })
    },
    pull: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.pull', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    fastForward: async ({ worktreePath, pushTarget }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.fastForward', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        pushTarget
      })
    },
    rebaseFromBase: async ({ worktreePath, baseRef }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      await callRuntimeResult('git.rebaseFromBase', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        baseRef
      })
    },
    branchDiff: async ({ worktreePath, filePath, compare, oldPath }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.branchDiff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        compare,
        oldPath
      })
    },
    commitDiff: async ({ worktreePath, filePath, commitOid, parentOid, oldPath }) => {
      const file = await resolveRuntimeFilePath(filePath, worktreePath)
      return callRuntimeResult('git.commitDiff', {
        worktree: toRuntimeWorktreeSelector(file.worktree.id),
        filePath: file.relativePath,
        commitOid,
        parentOid,
        oldPath
      })
    },
    commit: async ({ worktreePath, message }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.commit', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        message
      })
    },
    generateCommitMessage: async () => ({
      success: false,
      error: translate(
        'auto.web.web.preload.api.9fc90740b6',
        'Commit message generation is unavailable in the web client.'
      )
    }),
    discoverCommitMessageModels: async () => ({
      success: false,
      error: translate(
        'auto.web.web.preload.api.e57c82d276',
        'Commit message model discovery is unavailable in the web client.'
      )
    }),
    cancelGenerateCommitMessage: () => Promise.resolve(),
    generatePullRequestFields: async () => ({
      success: false,
      error: translate(
        'auto.web.web.preload.api.b8a1618172',
        'Pull request detail generation is unavailable in the web client.'
      )
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
        worktree: toRuntimeWorktreeSelector(worktree.id),
        relativePath,
        line
      })
    },
    remoteCommitUrl: async ({ worktreePath, sha }) => {
      const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
      return callRuntimeResult('git.remoteCommitUrl', {
        worktree: toRuntimeWorktreeSelector(worktree.id),
        sha
      })
    }
  }
}

function createBrowserApi(): NonNullable<Partial<PreloadApi>['browser']> {
  return {
    registerGuest: () => Promise.resolve(false),
    unregisterGuest: () => Promise.resolve(),
    openDevTools: () => Promise.resolve(false),
    setViewportOverride: () => Promise.resolve(false),
    setAnnotationViewportBridge: () => Promise.resolve(false),
    onGuestLoadFailed: () => noopUnsubscribe,
    onCertificateFailureChanged: () => noopUnsubscribe,
    proceedCertificate: () => Promise.resolve({ ok: false, reason: 'missing' }),
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
    cancelDownload: () => Promise.resolve(false),
    setGrabMode: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.31bea294d5',
          'Grab mode is unavailable in the web client.'
        )
      }),
    awaitGrabSelection: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.31bea294d5',
          'Grab mode is unavailable in the web client.'
        )
      }),
    cancelGrab: () => Promise.resolve(false),
    captureSelectionScreenshot: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.8dfcb7a351',
          'Selection screenshots are unavailable in the web client.'
        )
      }),
    extractHoverPayload: () =>
      Promise.resolve({
        ok: false,
        error: translate(
          'auto.web.web.preload.api.275a776357',
          'Hover extraction is unavailable in the web client.'
        )
      }),
    onGrabModeToggle: () => noopUnsubscribe,
    onGrabActionShortcut: () => noopUnsubscribe,
    sessionListProfiles: () => Promise.resolve([]),
    sessionCreateProfile: () => Promise.resolve(null),
    sessionDeleteProfile: () => Promise.resolve(false),
    sessionImportCookies: () =>
      Promise.resolve({
        ok: false,
        summary: null,
        error: translate(
          'auto.web.web.preload.api.67ec964791',
          'Cookie import is unavailable in the web client.'
        )
      }),
    sessionResolvePartition: () => Promise.resolve(null),
    sessionDetectBrowsers: () => Promise.resolve([]),
    sessionImportFromBrowser: () =>
      Promise.resolve({
        ok: false,
        summary: null,
        error: translate(
          'auto.web.web.preload.api.67ec964791',
          'Cookie import is unavailable in the web client.'
        )
      }),
    sessionClearDefaultCookies: () => Promise.resolve(false),
    notifyActiveTabChanged: () => Promise.resolve(false)
  } as unknown as NonNullable<Partial<PreloadApi>['browser']>
}

function createEmulatorApi(): NonNullable<Partial<PreloadApi>['emulator']> {
  return {
    onPaneFocus: () => noopUnsubscribe,
    onAutoAttach: () => noopUnsubscribe,
    startFrameStream: () => Promise.reject(new Error('Mobile emulator is unavailable on web.')),
    stopFrameStream: () => Promise.resolve(),
    onFrameStreamFrame: () => noopUnsubscribe,
    onFrameStreamError: () => noopUnsubscribe
  } as unknown as NonNullable<Partial<PreloadApi>['emulator']>
}

function createGitHubApi(): WebGitHubApi {
  const route = <Result>(method: WebGitHubRuntimeMethod, args?: unknown): Promise<Result> =>
    callRuntimeResult<Result>(method, mapRepoPathArg(args))
  const githubApi = {
    viewer: () => Promise.resolve(null),
    repoSlug: (args) => route<WebGitHubResult<'repoSlug'>>(GITHUB_WEB_RPC_METHODS.repoSlug, args),
    repoUpstream: (args) =>
      route<WebGitHubResult<'repoUpstream'>>(GITHUB_WEB_RPC_METHODS.repoUpstream, args),
    prForBranch: (args) =>
      route<WebGitHubResult<'prForBranch'>>(GITHUB_WEB_RPC_METHODS.prForBranch, args),
    refreshPRNow: async ({ candidate }) => {
      const acceptMergedFallbackPR =
        candidate.linkedPRNumber == null &&
        candidate.fallbackPRNumber != null &&
        candidate.fallbackPRSource != null
      const pr = await route<WebGitHubResult<'prForBranch'>>(GITHUB_WEB_RPC_METHODS.prForBranch, {
        repoPath: candidate.repoPath,
        repoId: candidate.repoId,
        branch: candidate.branch,
        linkedPRNumber: candidate.linkedPRNumber ?? null,
        fallbackPRNumber: candidate.fallbackPRNumber ?? null,
        currentHeadOid: candidate.currentHeadOid ?? null,
        ...(acceptMergedFallbackPR ? { acceptMergedFallbackPR: true } : {})
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
    notifyWorkItemMutated: () => Promise.resolve(false),
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
      Promise.resolve({
        ok: false,
        message: translate('auto.web.web.preload.api.31bfe8ae1a', 'Unavailable in the web client.')
      } as never),
    listAccessibleProjects: (args) =>
      route<WebGitHubResult<'listAccessibleProjects'>>(
        GITHUB_WEB_RPC_METHODS.listAccessibleProjects,
        args
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
    readClipboardText: async (options?: ReadClipboardTextOptions) =>
      assertClipboardTextWithinLimitWithYield(
        await (navigator.clipboard?.readText?.() ?? ''),
        options
      ),
    readSelectionClipboardText: () =>
      Promise.reject(new Error('Selection clipboard is unavailable in the web client')),
    saveClipboardImageAsTempFile: async (args?: {
      connectionId?: string | null
      runtimeEnvironmentId?: string | null
    }) => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      const contentBase64 = await readClipboardImagePngBase64()
      if (!contentBase64) {
        return null
      }
      return saveClipboardImageAsTempFileInRuntime(contentBase64, args)
    },
    writeClipboardText: async (text) => {
      await assertClipboardTextWriteWithinLimitWithYield(text)
      await (navigator.clipboard?.writeText?.(text) ?? Promise.resolve())
    },
    writeSelectionClipboardText: () =>
      Promise.reject(new Error('Selection clipboard is unavailable in the web client')),
    writeClipboardImage: () => Promise.resolve(),
    writeClipboardFile: () => Promise.resolve({ ok: false, reason: 'unsupported-platform' }),
    performNativePaste: () => {
      document.execCommand?.('paste')
    },
    onExportPdfRequested: () => noopUnsubscribe,
    onAppMenuPaste: () => noopUnsubscribe,
    onEditableContextPaste: () => noopUnsubscribe,
    getZoomLevel: () => zoomLevel,
    setZoomLevel: (level) => {
      zoomLevel = level
    },
    isMaximized: () => Promise.resolve(false),
    onOpenSettings: () => noopUnsubscribe,
    // Why: the web client has no native tray/menu bar, so there's never a queued open-settings intent to consume.
    consumePendingOpenSettings: () => Promise.resolve(false),
    onOpenSetupGuide: () => noopUnsubscribe,
    onOpenFeatureTour: () => noopUnsubscribe,
    onOpenCrashReport: () => noopUnsubscribe,
    // No desktop main process to push state changes; the web client re-reads via ui.get on interaction.
    onStateChanged: () => noopUnsubscribe,
    onToggleLeftSidebar: () => noopUnsubscribe,
    onToggleRightSidebar: () => noopUnsubscribe,
    onToggleWorktreePalette: () => noopUnsubscribe,
    onToggleFloatingTerminal: () => noopUnsubscribe,
    onTerminalShortcutCaptured: () => noopUnsubscribe,
    onOpenQuickOpen: () => noopUnsubscribe,
    onToggleQuickCommandsMenu: () => noopUnsubscribe,
    onOpenTasks: () => noopUnsubscribe,
    onOpenNewWorkspace: () => noopUnsubscribe,
    onDeleteCurrentWorkspace: () => noopUnsubscribe,
    onOpenWorkspaceBoard: () => noopUnsubscribe,
    onJumpToWorktreeIndex: () => noopUnsubscribe,
    onJumpToTabIndex: () => noopUnsubscribe,
    onWorktreeHistoryNavigate: () => noopUnsubscribe,
    onNewBrowserTab: () => noopUnsubscribe,
    onNewMarkdownTab: () => noopUnsubscribe,
    onNewSimulatorTab: () => noopUnsubscribe,
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
    onBrowserHistoryNavigate: () => noopUnsubscribe,
    onZoomBrowserPage: () => noopUnsubscribe,
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
    onActivateWorktree: () => noopUnsubscribe,
    onCreateTerminal: () => noopUnsubscribe,
    onRequestTerminalCreate: () => noopUnsubscribe,
    onRequestTerminalTabMount: () => noopUnsubscribe,
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
    onTerminalTabCloseRequest: () => noopUnsubscribe,
    respondTerminalTabClose: () => {},
    onSleepWorktree: () => noopUnsubscribe,
    // Why: paired web is a full renderer that wakes on activation; mobile wake is desktop-host-scoped and never reaches web.
    onResumeSleepingAgents: () => noopUnsubscribe,
    onTerminalZoom: () => noopUnsubscribe,
    // Why: a paired web client has no OS sleep signal; occlusion-driven visibilitychange already covers wake recovery.
    onSystemResumed: () => noopUnsubscribe,
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
  type WindowsTerminalCapabilityBridgeResult = {
    wslAvailable: boolean
    wslDistros: string[]
    pwshAvailable: boolean
    gitBashAvailable: boolean
    hostPlatform: NodeJS.Platform | null
  }
  const fallbackWindowsTerminalCapabilities = {
    wslAvailable: false,
    wslDistros: [],
    pwshAvailable: false,
    gitBashAvailable: false,
    hostPlatform: null
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
        : [],
    detectRemoteWindowsTerminalCapabilities: async (args) =>
      requireActiveEnvironmentOrNull()
        ? callRuntimeResult<WindowsTerminalCapabilityBridgeResult>(
            'preflight.detectRemoteWindowsTerminalCapabilities',
            args
          ).catch(() => fallbackWindowsTerminalCapabilities)
        : Promise.resolve(fallbackWindowsTerminalCapabilities)
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
    getWslInstallStatus: (_args?: { distro?: string | null }) => Promise.resolve(status),
    installWsl: (_args?: { distro?: string | null }) => Promise.resolve(status),
    removeWsl: (_args?: { distro?: string | null }) => Promise.resolve(status)
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
      | 'devin'
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
    hermesStatus: () => status('hermes'),
    devinStatus: () => status('devin')
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
    discover: (target) =>
      callRuntimeResult<SkillDiscoveryResult>('skills.discover', target, 15_000),
    // Why: browser clients have no local skill homes; remote-host freshness stays off until its update rail covers it.
    freshnessInventory: (): Promise<SkillFreshnessInventory> =>
      Promise.resolve({
        schemaVersion: 1,
        installations: [],
        eligibleUpdateNames: [],
        scannedAt: Date.now()
      })
  }
}

function createNotificationsApi(): NonNullable<Partial<PreloadApi>['notifications']> {
  return {
    dispatch: () => Promise.resolve({ delivered: false, reason: 'not-supported' }),
    dismiss: () => Promise.resolve({ dismissed: 0 }),
    openSystemSettings: () => Promise.resolve(),
    getPermissionStatus: () =>
      Promise.resolve({ supported: false, platform: getBrowserPlatform(), requested: false }),
    probeDelivery: () => Promise.resolve({ state: 'unsupported' as const, authoritative: false }),
    playSound: () => Promise.resolve({ played: false, reason: 'missing-path' })
  }
}

function createRateLimitsApi(): NonNullable<Partial<PreloadApi>['rateLimits']> {
  const empty: RateLimitState = {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
  return {
    get: () => Promise.resolve(empty),
    refresh: () => Promise.resolve(empty),
    refreshCodexForTarget: () => Promise.resolve(empty),
    // Why: web clients don't own local Codex auth; report the safe no-credit outcome since redemption is desktop-only.
    consumeCodexResetCredit: () => Promise.resolve({ outcome: 'noCredit', state: empty }),
    refreshClaudeForTarget: () => Promise.resolve(empty),
    setPollingInterval: () => Promise.resolve(),
    fetchInactiveClaudeAccounts: () => Promise.resolve(),
    fetchInactiveCodexAccounts: () => Promise.resolve(),
    refreshMiniMax: () => Promise.resolve(empty),
    refreshGrok: () => Promise.resolve(empty),
    onUpdate: () => noopUnsubscribe
  }
}

function createMiniMaxCredentialsApi(): NonNullable<Partial<PreloadApi>['minimaxCredentials']> {
  const notConfigured = { configured: false }
  const unsupportedError = new Error('MiniMax cookie storage is only available in the desktop app.')
  return {
    getStatus: () => Promise.resolve(notConfigured),
    saveCookie: () => Promise.reject(unsupportedError),
    clearCookie: () => Promise.resolve(notConfigured)
  }
}

function createGrokAccountsApi(): NonNullable<Partial<PreloadApi>['grokAccounts']> {
  const unsigned = {
    signedIn: false,
    email: null,
    teamId: null,
    tokenFresh: false,
    error: null
  }
  return {
    getStatus: () => Promise.resolve(unsigned)
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
    cancelPendingLogin: () => Promise.resolve(false),
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
    claimViewport: () => {},
    reportGeometry: () => {},
    signal: () => {},
    // Web panes clear the host buffer via the terminal.clearBuffer runtime RPC.
    clearBuffer: () => {},
    kill: () => Promise.resolve(),
    ackColdRestore: () => {},
    ackData: () => {},
    onDeliveryResyncRequest: () => noopUnsubscribe,
    respondDeliveryResync: () => {},
    // Why: web terminals bypass main's delivery gate; a zero-in-flight reply keeps the watchdog idle.
    reportRendererDeliveryState: () =>
      Promise.resolve({ inFlightTotalChars: 0, inFlightPtyCount: 0, msSinceLastAck: null }),
    getPtyDataListenerCount: () => 0,
    rendererDispatcherReady: () => {},
    setActiveRendererPty: () => {},
    setRendererPtyVisible: () => {},
    setHiddenRendererPty: () => {},
    setPtyDeliveryInterest: () => {},
    // Why: remote-runtime PTYs are never hidden-gate markable, so there's no main-side responder to feed.
    publishTerminalViewAttributes: () => {},
    hasChildProcesses: () => Promise.resolve(false),
    getForegroundProcess: () => Promise.resolve(null),
    inspectProcess: () => Promise.reject(new Error('terminal_liveness_unavailable')),
    // Why: paired web panes cannot provide a local post-boundary process scan.
    confirmForegroundProcess: () => Promise.resolve(null),
    getCwd: () => Promise.resolve('~'),
    getSize: () => Promise.resolve(null),
    listSessions: () => Promise.resolve([]),
    getAuthoritativeBufferSnapshotCapabilities: (ids) =>
      ids.map((id) => ({ id, authoritative: false })),
    hasPty: () => Promise.resolve(null),
    getMainBufferSnapshot: () => Promise.resolve(null),
    // Why: remote-runtime PTYs skip local main (no side-effect source); renderer byte parsing stays authoritative.
    onSideEffect: () => noopUnsubscribe,
    getSideEffectSnapshot: () => Promise.resolve(null),
    getRendererDeliveryDebugSnapshot: () =>
      Promise.resolve({
        pendingPtyCount: 0,
        pendingChars: 0,
        maxPendingCharsByPty: 0,
        rendererInFlightPtyCount: 0,
        rendererInFlightChars: 0,
        maxRendererInFlightCharsByPty: 0,
        activeRendererPtyCount: 0,
        flushScheduled: false,
        peakPendingChars: 0,
        peakMaxPendingCharsByPty: 0,
        peakRendererInFlightChars: 0,
        peakMaxRendererInFlightCharsByPty: 0,
        ackGatedFlushSkipCount: 0,
        hiddenDeliveryGatedPtyCount: 0,
        hiddenDeliveryGatedVisiblePtyCount: 0,
        hiddenDeliveryGatedActivePtyCount: 0,
        deliveryInterestPtyCount: 0,
        hiddenDeliveryDroppedChars: 0,
        hiddenDeliveryDroppedChunks: 0,
        pendingDroppedChars: 0,
        diagnostics: EMPTY_PTY_MAIN_DELIVERY_DIAGNOSTICS,
        rendererLifecycleResetCount: 0,
        lastLifecycleResetClearedChars: 0,
        rendererPtyDispatcherReady: false,
        rendererDispatcherReadyForcedCount: 0
      }),
    resetRendererDeliveryDebug: () => Promise.resolve(),
    onData: () => noopUnsubscribe,
    onReplay: () => noopUnsubscribe,
    onModelRestoreNeeded: () => noopUnsubscribe,
    onExit: () => noopUnsubscribe,
    onSpawned: () => noopUnsubscribe,
    onSerializeBufferRequest: () => noopUnsubscribe,
    onClearBufferRequest: () => noopUnsubscribe,
    sendSerializedBuffer: () => {},
    declarePendingPaneSerializer: () => Promise.resolve(0),
    settlePaneSerializer: () => Promise.resolve(),
    clearPendingPaneSerializer: () => Promise.resolve(),
    reportRendererSerializerReady: () => Promise.resolve(),
    management: {
      listSessions: () => Promise.resolve({ sessions: [], degraded: false }),
      killAll: () => Promise.resolve({ killedCount: 0, remainingCount: 0, killedSessionIds: [] }),
      killOne: () => Promise.resolve({ success: false }),
      restart: () => Promise.resolve({ success: false })
    }
  }
}

function createSshApi(): NonNullable<Partial<PreloadApi>['ssh']> {
  return {
    // Why: SSH is owned by the paired host; route read/connect to runtime RPC for state/reconnect (STA-1468). Target mgmt is desktop-only.
    listTargets: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return []
      }
      const { targets } = await callRuntimeResult<{ targets: SshTarget[] }>(
        'ssh.listTargetSummaries'
      )
      return targets
    },
    listRemovedTargetLabels: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return {}
      }
      const { labels } = await callRuntimeResult<{ labels: Record<string, string> }>(
        'ssh.listRemovedTargetLabels'
      )
      return labels
    },
    addTarget: () =>
      Promise.reject(new Error('SSH target management is unavailable in the web client.')),
    updateTarget: () =>
      Promise.reject(new Error('SSH target management is unavailable in the web client.')),
    removeTarget: () => Promise.resolve(),
    importConfig: () => Promise.resolve({ targets: [], repoReadoptions: [] }),
    connect: async (args) => {
      const { state } = await callRuntimeResult<{ state: SshConnectionState | null }>(
        'ssh.connect',
        { targetId: args.targetId }
      )
      return state
    },
    disconnect: () => Promise.resolve(),
    terminateSessions: () => Promise.resolve(),
    resetRelay: () => Promise.resolve(),
    getState: async (args) => {
      if (!requireActiveEnvironmentOrNull()) {
        return null
      }
      const { state } = await callRuntimeResult<{ state: SshConnectionState | null }>(
        'ssh.getState',
        { targetId: args.targetId }
      )
      return state
    },
    needsPassphrasePrompt: () => Promise.resolve(false),
    testConnection: () =>
      Promise.resolve({
        success: false,
        error: translate('auto.web.web.preload.api.31bfe8ae1a', 'Unavailable in the web client.')
      }),
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

async function callRuntimeResultWithOwner<TResult>(
  method: string,
  params?: unknown,
  timeoutMs?: number
): Promise<{ result: TResult; hostId: ExecutionHostId; environmentId: string }> {
  const environmentId = requireActiveEnvironment().id
  const result = await callRuntimeResult<TResult>(method, params, timeoutMs)
  return { result, hostId: toRuntimeExecutionHostId(environmentId), environmentId }
}

function withRuntimeRepoOwner(repo: Repo, hostId: ExecutionHostId): Repo {
  return { ...repo, executionHostId: hostId }
}

function withRuntimeRepoMutationOwner(
  result: { repo: Repo } | { error: string },
  hostId: ExecutionHostId
): { repo: Repo } | { error: string } {
  return 'repo' in result ? { ...result, repo: withRuntimeRepoOwner(result.repo, hostId) } : result
}

function withRuntimeWorktreeOwner<T extends Worktree>(worktree: T, hostId: ExecutionHostId): T {
  const runtimeOwner = parseExecutionHostId(hostId)
  if (runtimeOwner?.kind !== 'runtime') {
    return worktree
  }
  return { ...worktree, runtimeOwnerEnvironmentId: runtimeOwner.environmentId }
}

function captureWebFileMutationSession(): {
  resolveFilePath: (filePath: string) => Promise<Awaited<ReturnType<typeof resolveRuntimeFilePath>>>
  assertMutationSupported: () => Promise<void>
  callRuntimeResult: WebRuntimeResultCaller
  getSshState: (targetId: string) => Promise<SshConnectionState | null>
} {
  const environment = requireActiveEnvironment()
  const client = getClientForEnvironment(environment)
  const assertCurrent = (): void => {
    if (activeClient !== client || requireActiveEnvironmentOrNull()?.id !== environment.id) {
      throw new Error('Runtime pairing changed; refresh and try again')
    }
  }
  const callBoundRuntimeEnvelope: WebRuntimeEnvelopeCaller = async <TResult>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<RuntimeRpcResponse<TResult>> => {
    assertCurrent()
    const response = await runtimeCallQueuePool.enqueue(environment.id, method, () => {
      assertCurrent()
      return client.call(method, params, { timeoutMs })
    })
    assertCurrent()
    updateEnvironmentFromResponse(environment, response)
    return response as RuntimeRpcResponse<TResult>
  }
  const callBoundRuntimeResult: WebRuntimeResultCaller = async <TResult>(
    method: string,
    params?: unknown,
    timeoutMs?: number
  ): Promise<TResult> => {
    const response = await callBoundRuntimeEnvelope<TResult>(method, params, timeoutMs)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    return response.result as TResult
  }
  return {
    resolveFilePath: (filePath) =>
      resolveRuntimeFilePath(
        filePath,
        undefined,
        callBoundRuntimeResult,
        callBoundRuntimeEnvelope,
        false,
        environment.id
      ),
    assertMutationSupported: async () => {
      assertFileMutationOwnershipCapability(
        await callBoundRuntimeResult<RuntimeStatus>('status.get', undefined, 15_000)
      )
    },
    callRuntimeResult: callBoundRuntimeResult,
    getSshState: async (targetId) =>
      (
        await callBoundRuntimeResult<{ state: SshConnectionState | null }>('ssh.getState', {
          targetId
        })
      ).state
  }
}

async function saveClipboardImageAsTempFileInRuntime(
  contentBase64: string,
  args?: { connectionId?: string | null; runtimeEnvironmentId?: string | null }
): Promise<string> {
  if (contentBase64.length > MAX_CLIPBOARD_IMAGE_BASE64_CHARS) {
    throw new Error(CLIPBOARD_IMAGE_TOO_LARGE_ERROR)
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
    // Why: after chunked paste holds server-side state, release the bounded slot on failure rather than wait for TTL cleanup.
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
  webGitStatusRequestOwners.abortAll()
  activeClient?.close()
  activeClient = null
  activeClientEnvironmentId = null
  invalidateRuntimeWorktreeCaches()
}

function disposeWebPreloadOwnedState(): void {
  disposeWebKeybindingSubscriptions()
  closeActiveRuntimeClients()
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
  if (environment.compatibleEnvironmentIds?.includes(selector)) {
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

function assertActiveEnvironment(environmentId: string): void {
  if (requireActiveEnvironment().id !== environmentId) {
    throw new Error('The paired Orca server changed while the request was in progress.')
  }
}

function updateEnvironmentFromResponse(
  environment: StoredWebRuntimeEnvironment,
  response: RuntimeRpcResponse<unknown>
): void {
  if (activeEnvironment?.id !== environment.id) {
    return
  }
  const runtimeId = response.ok ? response._meta.runtimeId : (response._meta?.runtimeId ?? null)
  activeEnvironment = updateStoredEnvironmentRuntimeId(environment, runtimeId)
}

function getStoredSettings(): GlobalSettings {
  activeEnvironment = activeEnvironment ?? readStoredWebRuntimeEnvironment()
  const defaults = getDefaultSettings('~')
  const storedResult = readJsonWithMetadata<Partial<GlobalSettings>>(SETTINGS_STORAGE_KEY, {})
  const stored = storedResult.value
  const migratedStored = {
    ...stored,
    ...normalizeAutoRenameBranchFromWorkDefaultOn(stored),
    ...normalizeTerminalCursorStyleDefault(stored),
    terminalCustomThemes: normalizeTerminalCustomThemes(stored.terminalCustomThemes),
    uiLanguage: normalizeUiLanguage(stored.uiLanguage)
  }
  if (
    storedResult.parsedPlainObject &&
    (stored.autoRenameBranchFromWork !== migratedStored.autoRenameBranchFromWork ||
      stored.autoRenameBranchFromWorkDefaultedOn !==
        migratedStored.autoRenameBranchFromWorkDefaultedOn ||
      stored.terminalCursorStyle !== migratedStored.terminalCursorStyle ||
      stored.terminalCursorStyleDefaultedToBlock !==
        migratedStored.terminalCursorStyleDefaultedToBlock ||
      stored.terminalCustomThemes !== migratedStored.terminalCustomThemes ||
      stored.uiLanguage !== migratedStored.uiLanguage)
  ) {
    writeJson(SETTINGS_STORAGE_KEY, migratedStored)
  }
  return mergeSettings(
    {
      ...defaults,
      floatingTerminalEnabled: false,
      rightSidebarOpenByDefault: false,
      activeRuntimeEnvironmentId: null
    },
    migratedStored
  )
}

function writeStoredSettings(
  settings: GlobalSettings,
  explicitActiveRuntimeEnvironmentId?: string | null
): void {
  const durable = { ...settings }
  if (explicitActiveRuntimeEnvironmentId !== undefined) {
    durable.activeRuntimeEnvironmentId = explicitActiveRuntimeEnvironmentId
  } else {
    const stored = readJson<Partial<GlobalSettings>>(SETTINGS_STORAGE_KEY, {})
    if (Object.hasOwn(stored, 'activeRuntimeEnvironmentId')) {
      durable.activeRuntimeEnvironmentId = stored.activeRuntimeEnvironmentId ?? null
    } else {
      delete durable.activeRuntimeEnvironmentId
    }
  }
  writeJson(SETTINGS_STORAGE_KEY, durable)
}

async function getRuntimeBackedStoredSettings(): Promise<GlobalSettings> {
  const local = getStoredSettings()
  if (!requireActiveEnvironmentOrNull()) {
    return local
  }
  try {
    const result = await callRuntimeResult<{ settings: Partial<GlobalSettings> }>(
      'settings.get',
      undefined,
      15_000
    )
    const runtimeSettings: Partial<GlobalSettings> = {}
    if (typeof result.settings.experimentalNewWorktreeCardStyle === 'boolean') {
      runtimeSettings.experimentalNewWorktreeCardStyle =
        result.settings.experimentalNewWorktreeCardStyle
    }
    if (typeof result.settings.compactWorktreeCards === 'boolean') {
      runtimeSettings.compactWorktreeCards = result.settings.compactWorktreeCards
    }
    if (typeof result.settings.minimaxGroupId === 'string') {
      runtimeSettings.minimaxGroupId = result.settings.minimaxGroupId
    }
    if (typeof result.settings.minimaxUsageModels === 'string') {
      runtimeSettings.minimaxUsageModels = result.settings.minimaxUsageModels
    }
    if (Array.isArray(result.settings.prBotAuthorOverrides)) {
      runtimeSettings.prBotAuthorOverrides = normalizePRBotAuthorOverrides(
        result.settings.prBotAuthorOverrides
      )
    }
    const next = mergeSettings(local, runtimeSettings)
    writeStoredSettings(next)
    return next
  } catch {
    // Why: unpaired/offline web clients keep a local settings fallback.
    return local
  }
}

async function syncRuntimeBackedSettings(
  updates: Partial<GlobalSettings>,
  localNext: GlobalSettings
): Promise<GlobalSettings> {
  if (!requireActiveEnvironmentOrNull()) {
    return localNext
  }
  const runtimeUpdates: Partial<GlobalSettings> = {}
  if (typeof updates.experimentalNewWorktreeCardStyle === 'boolean') {
    runtimeUpdates.experimentalNewWorktreeCardStyle = updates.experimentalNewWorktreeCardStyle
  }
  if (typeof updates.compactWorktreeCards === 'boolean') {
    runtimeUpdates.compactWorktreeCards = updates.compactWorktreeCards
  }
  if (typeof updates.minimaxGroupId === 'string') {
    runtimeUpdates.minimaxGroupId = updates.minimaxGroupId
  }
  if (typeof updates.minimaxUsageModels === 'string') {
    runtimeUpdates.minimaxUsageModels = updates.minimaxUsageModels
  }
  if (Array.isArray(updates.prBotAuthorOverrides)) {
    runtimeUpdates.prBotAuthorOverrides = normalizePRBotAuthorOverrides(
      updates.prBotAuthorOverrides
    )
  }
  if (Object.keys(runtimeUpdates).length === 0) {
    return localNext
  }
  try {
    const result = await callRuntimeResult<{ settings: Partial<GlobalSettings> }>(
      'settings.update',
      runtimeUpdates,
      15_000
    )
    const runtimeSettings = { ...result.settings }
    delete runtimeSettings.activeRuntimeEnvironmentId
    const next = mergeSettings(localNext, runtimeSettings)
    writeStoredSettings(next)
    return next
  } catch {
    // Why: unpaired/offline web clients still need local settings persistence.
    return localNext
  }
}

async function updateRuntimePRBotAuthorOverride(args: {
  author: string
  isBot: boolean
}): Promise<GlobalSettings> {
  const local = getStoredSettings()
  if (requireActiveEnvironmentOrNull()) {
    // Why: don't report a successful mark the authoritative runtime failed to persist and will later overwrite.
    const result = await callRuntimeResult<{ settings: Partial<GlobalSettings> }>(
      'settings.updatePRBotAuthorOverride',
      args,
      15_000
    )
    const next = mergeSettings(local, {
      prBotAuthorOverrides: normalizePRBotAuthorOverrides(result.settings.prBotAuthorOverrides)
    })
    writeStoredSettings(next)
    return next
  }
  const next = mergeSettings(local, {
    prBotAuthorOverrides: applyPRBotAuthorOverride(
      local.prBotAuthorOverrides,
      args.author,
      args.isBot
    )
  })
  writeStoredSettings(next)
  return next
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
  // Why: paired clients already have an Orca server; skip desktop first-run onboarding that would probe browser-local tools.
  writeJson(ONBOARDING_STORAGE_KEY, closed)
  return closed
}

/** Resolve the localStorage key for a session partition; non-'local' hosts get a host-suffixed key so they never clobber the local one. */
function sessionStorageKeyForHost(hostId?: string | null): string {
  const resolved = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  return resolved === LOCAL_EXECUTION_HOST_ID
    ? SESSION_STORAGE_KEY
    : `${SESSION_STORAGE_KEY}.${resolved}`
}

function getStoredWorkspaceSession(hostId?: string | null): WorkspaceSessionState {
  const resolvedHostId = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  if (resolvedHostId !== LOCAL_EXECUTION_HOST_ID) {
    return sanitizeWebRuntimeWorkspaceSession(
      readJson(sessionStorageKeyForHost(resolvedHostId), getDefaultWorkspaceSession())
    )
  }
  const localSession = sanitizeWebRuntimeWorkspaceSession(
    readJson(SESSION_STORAGE_KEY, getDefaultWorkspaceSession())
  )
  if (!requireActiveEnvironmentOrNull()) {
    return localSession
  }
  const ui = readLocalWebUIState()
  // Why: replaying browser-local terminal handles first creates stale remote PTYs; mirror host session-tabs instead.
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
  const storedSettings = getStoredSettings()
  const base = {
    ...defaults,
    // Why: mirror the main-process missing-property seed from legacy card layout mode when runtime ui.get is unavailable.
    worktreeCardProperties: getWorktreeCardModeProperties(
      storedSettings.compactWorktreeCards ? 'Compact' : 'Default'
    )
  }
  if (typeof stored.rightSidebarOpen === 'boolean') {
    return mergeWebUIState(base, stored)
  }
  return mergeWebUIState(base, {
    ...stored,
    // Why: web fallback lacks main-process normalization; migrate the retired setting only when local UI preference is absent.
    rightSidebarOpen: storedSettings.rightSidebarOpenByDefault
  })
}

function mergeWebUIState(
  base: PersistedUIState,
  updates: Partial<PersistedUIState>
): PersistedUIState {
  const { featureInteractionTelemetryBuckets: _reserved, ...safeUpdates } =
    updates as Partial<PersistedUIState> & {
      featureInteractionTelemetryBuckets?: unknown
    }
  void _reserved
  return {
    ...base,
    ...safeUpdates,
    worktreeCardProperties: normalizeWorktreeCardProperties(
      safeUpdates.worktreeCardProperties ?? base.worktreeCardProperties
    ),
    _worktreeCardModeDefaulted:
      safeUpdates._worktreeCardModeDefaulted ?? base._worktreeCardModeDefaulted,
    agentActivityDisplayMode: normalizeAgentActivityDisplayMode(
      safeUpdates.agentActivityDisplayMode ?? base.agentActivityDisplayMode
    ),
    usagePercentageDisplay: normalizeUsagePercentageDisplay(
      safeUpdates.usagePercentageDisplay ?? base.usagePercentageDisplay
    ),
    statusBarUsageMode: normalizeStatusBarUsageMode(
      safeUpdates.statusBarUsageMode ?? base.statusBarUsageMode
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

function mergeSettings(
  base: GlobalSettings,
  updates: Partial<GlobalSettings>,
  options: { preserveAutoRenameBranchFromWorkUpdate?: boolean } = {}
): GlobalSettings {
  const defaults = getDefaultSettings('~')
  const merged = {
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
    agentDefaultArgs: normalizeTuiAgentArgsRecord(
      updates.agentDefaultArgs ?? base.agentDefaultArgs
    ),
    agentDefaultEnv: normalizeTuiAgentEnvRecord(updates.agentDefaultEnv ?? base.agentDefaultEnv),
    voice: {
      ...(base.voice ?? defaults.voice),
      ...updates.voice
    } as NonNullable<GlobalSettings['voice']>,
    activeRuntimeEnvironmentId: Object.hasOwn(updates, 'activeRuntimeEnvironmentId')
      ? (updates.activeRuntimeEnvironmentId ?? null)
      : (base.activeRuntimeEnvironmentId ?? null),
    terminalCustomThemes: normalizeTerminalCustomThemes(
      updates.terminalCustomThemes ?? base.terminalCustomThemes
    ),
    uiLanguage: normalizeUiLanguage(updates.uiLanguage ?? base.uiLanguage)
  }
  return {
    ...merged,
    ...normalizeAutoRenameBranchFromWorkDefaultOn(merged, {
      preserveExplicitValue: options.preserveAutoRenameBranchFromWorkUpdate
    })
  }
}

async function listAllRuntimeWorktrees(): Promise<Worktree[]> {
  if (cachedWorktrees && Date.now() - cachedWorktrees.loadedAt < 5_000) {
    return cachedWorktrees.worktrees
  }
  const owned = await callRuntimeResultWithOwner<{ worktrees: Worktree[] }>('worktree.list', {
    limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT
  })
  const worktrees = owned.result.worktrees.map((worktree) =>
    withRuntimeWorktreeOwner(worktree, owned.hostId)
  )
  assertActiveEnvironment(owned.environmentId)
  cachedWorktrees = { loadedAt: Date.now(), worktrees }
  return worktrees
}

async function listAllRuntimeDetectedWorktrees(
  callResult: WebRuntimeResultCaller = callRuntimeResult,
  callEnvelope: WebRuntimeEnvelopeCaller = callRuntimeEnvelope,
  useCache = true,
  expectedEnvironmentId = requireActiveEnvironment().id
): Promise<Worktree[]> {
  if (
    useCache &&
    cachedDetectedWorktrees &&
    Date.now() - cachedDetectedWorktrees.loadedAt < 5_000
  ) {
    return cachedDetectedWorktrees.worktrees
  }

  assertActiveEnvironment(expectedEnvironmentId)
  const repos = (await callResult<{ repos: Repo[] }>('repo.list')).repos
  const detectedLists = await mapWithConcurrency(
    repos,
    WEB_RUNTIME_REPO_DISCOVERY_CONCURRENCY,
    (repo) => callRuntimeDetectedWorktrees(repo.id, expectedEnvironmentId, callResult, callEnvelope)
  )
  const worktrees = detectedLists.flatMap((result) => result.worktrees)
  assertActiveEnvironment(expectedEnvironmentId)
  if (useCache) {
    cachedDetectedWorktrees = { loadedAt: Date.now(), worktrees }
  }
  return worktrees
}

async function callRuntimeDetectedWorktrees(
  repoId: string,
  expectedEnvironmentId = requireActiveEnvironment().id,
  callResult: WebRuntimeResultCaller = callRuntimeResult,
  callEnvelope: WebRuntimeEnvelopeCaller = callRuntimeEnvelope
): Promise<DetectedWorktreeListResult> {
  assertActiveEnvironment(expectedEnvironmentId)
  const hostId = toRuntimeExecutionHostId(expectedEnvironmentId)
  const response = await callEnvelope<DetectedWorktreeListResult>(
    'worktree.detectedList',
    { repo: repoId },
    15_000
  )
  if (response.ok) {
    return {
      ...response.result,
      worktrees: response.result.worktrees.map((worktree) =>
        withRuntimeWorktreeOwner(worktree, hostId)
      )
    }
  }
  if (response.error.code !== 'method_not_found') {
    throw new Error(response.error.message)
  }

  assertActiveEnvironment(expectedEnvironmentId)
  const legacy = await callResult<{ worktrees: Worktree[] }>(
    'worktree.list',
    { repo: repoId, limit: WEB_RUNTIME_WORKTREE_LIST_LIMIT },
    15_000
  )
  return toLegacyDetectedWorktreeResult(
    repoId,
    legacy.worktrees.map((worktree) => withRuntimeWorktreeOwner(worktree, hostId))
  )
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

async function resolveRuntimeWorktreeByPath(
  worktreePath: string,
  callResult: WebRuntimeResultCaller = callRuntimeResult,
  callEnvelope: WebRuntimeEnvelopeCaller = callRuntimeEnvelope,
  useDetectedWorktreeCache = true,
  expectedEnvironmentId = requireActiveEnvironment().id
): Promise<Worktree> {
  // Why: hidden-but-open worktrees must still resolve, but `worktree.list` is sidebar-visible only — resolve via detected rows.
  const worktrees = await listAllRuntimeDetectedWorktrees(
    callResult,
    callEnvelope,
    useDetectedWorktreeCache,
    expectedEnvironmentId
  )
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
  preferredWorktreePath?: string,
  callResult: WebRuntimeResultCaller = callRuntimeResult,
  callEnvelope: WebRuntimeEnvelopeCaller = callRuntimeEnvelope,
  useDetectedWorktreeCache = true,
  expectedEnvironmentId = requireActiveEnvironment().id
): Promise<{ worktree: Worktree; relativePath: string }> {
  const worktree = preferredWorktreePath
    ? await resolveRuntimeWorktreeByPath(
        preferredWorktreePath,
        callResult,
        callEnvelope,
        useDetectedWorktreeCache,
        expectedEnvironmentId
      )
    : await resolveRuntimeWorktreeByPath(
        filePath,
        callResult,
        callEnvelope,
        useDetectedWorktreeCache,
        expectedEnvironmentId
      )
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
  await callRuntimeResult(method, {
    worktree: toRuntimeWorktreeSelector(file.worktree.id),
    filePath: file.relativePath
  })
}

async function mutateGitPaths(
  method: string,
  worktreePath: string,
  filePaths: string[]
): Promise<void> {
  const worktree = await resolveRuntimeWorktreeByPath(worktreePath)
  await callRuntimeResult(method, { worktree: toRuntimeWorktreeSelector(worktree.id), filePaths })
}

function mapRepoPathArg(args: unknown): unknown {
  if (!args || typeof args !== 'object' || !('repoPath' in args)) {
    return args
  }
  const record = args as Record<string, unknown>
  const repoId = typeof record.repoId === 'string' && record.repoId.trim() ? record.repoId : null
  return {
    ...record,
    // Why: duplicate checked-out repos make path/name selectors ambiguous; prefer the explicit repo id the renderer passes.
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
  return readJsonWithMetadata(key, fallback).value
}

function readJsonWithMetadata<T>(
  key: string,
  fallback: T
): { value: T; parsedPlainObject: boolean } {
  const raw = window.localStorage.getItem(key)
  if (!raw) {
    return { value: cloneJson(fallback), parsedPlainObject: false }
  }
  try {
    const parsed = parseWebLocalStorageJson(raw)
    return {
      value: { ...cloneJson(fallback), ...(parsed as object) } as T,
      parsedPlainObject: parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    }
  } catch {
    return { value: cloneJson(fallback), parsedPlainObject: false }
  }
}

function writeJson<T>(key: string, value: T): void {
  window.localStorage.setItem(key, stringifyWebLocalStorageJson(value))
}

function cloneJson<T>(value: T): T {
  return parseWebLocalStorageJson<T>(stringifyWebLocalStorageJson(value))
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
