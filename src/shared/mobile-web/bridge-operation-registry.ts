import { z } from 'zod'

/** How an operation touches host state. Mutations must reauthorize an opaque handle they
 * resolved before any await that precedes the host write. */
export type MobileWebBridgeOperationKind = 'read' | 'mutation' | 'subscription'

export const MOBILE_WEB_BRIDGE_OPERATIONS = {
  workspace: {
    snapshot: 'read',
    repositories: 'read',
    subscribe: 'subscription',
    activate: 'mutation',
    update: 'mutation',
    remove: 'mutation',
    creationRepositories: 'read',
    creationRetiredNames: 'read',
    creationSettings: 'read',
    creationTrustedHooks: 'read',
    creationGitLabAvailability: 'read',
    creationLinearAvailability: 'read',
    creationSshState: 'read',
    creationSshConnect: 'mutation',
    creationDetectAgents: 'read',
    creationRepoHooks: 'read',
    creationRuntimeCapabilities: 'read',
    creationSparsePresets: 'read',
    creationSaveSparsePreset: 'mutation',
    creationPersistTrust: 'mutation',
    creationSearchGitHub: 'read',
    creationSearchGitLab: 'read',
    creationSearchLinear: 'read',
    creationSearchBranches: 'read',
    creationResolveRepoSlug: 'read',
    creationLookupGitHub: 'read',
    creationLookupGitHubRepo: 'read',
    creationLookupGitLab: 'read',
    creationResolvePrBase: 'read',
    creationResolveMrBase: 'read',
    creationCreateBlank: 'mutation',
    creationCreateFromSource: 'mutation'
  },
  session: {
    capabilities: 'read',
    snapshot: 'read',
    subscribe: 'subscription',
    agentOptions: 'read',
    quickCommands: 'read',
    quickCommandMutate: 'mutation',
    create: 'mutation',
    createAgent: 'mutation',
    createQuickCommand: 'mutation',
    createBrowser: 'mutation',
    activate: 'mutation',
    close: 'mutation'
  },
  terminal: {
    subscribe: 'subscription',
    input: 'mutation',
    queryReply: 'mutation',
    clipboardPaste: 'mutation',
    attachImage: 'mutation',
    resize: 'mutation',
    visibility: 'mutation',
    displayMode: 'mutation',
    clear: 'mutation',
    rename: 'mutation',
    resync: 'mutation',
    ack: 'mutation',
    cancel: 'mutation'
  },
  file: {
    list: 'read',
    directory: 'read',
    read: 'read',
    readChunk: 'read',
    search: 'read',
    write: 'mutation',
    markdownRead: 'read',
    markdownSave: 'mutation',
    markdownDraftRead: 'read',
    markdownDraftWrite: 'mutation',
    open: 'mutation',
    resolveTerminalPath: 'read',
    readTerminalArtifactChunk: 'read',
    releaseTerminalArtifact: 'mutation'
  },
  sourceControl: {
    status: 'read',
    diff: 'read',
    subscribe: 'subscription',
    stage: 'mutation',
    unstage: 'mutation',
    discard: 'mutation',
    commit: 'mutation',
    generateCommitMessage: 'mutation',
    cancelCommitMessageGeneration: 'mutation',
    branch: 'mutation',
    branches: 'read',
    history: 'read',
    branchCompare: 'read',
    commitCompare: 'read',
    reviewMetadata: 'read',
    reviewMetadataUpdate: 'mutation',
    reviewLink: 'read',
    reviewLinkUpdate: 'mutation',
    reviewDiff: 'read',
    reviewOpen: 'mutation',
    reviewTerminalSend: 'mutation',
    upstream: 'read',
    fetch: 'mutation',
    pull: 'mutation',
    push: 'mutation',
    rebase: 'mutation',
    abort: 'mutation'
  },
  task: {
    bootstrap: 'read',
    repositories: 'read',
    linearContext: 'read',
    resolveRepoSlug: 'read',
    updateResume: 'mutation',
    updateSettings: 'mutation',
    listGitHub: 'read',
    countGitHub: 'read',
    listGitLab: 'read',
    listGitLabTodos: 'read',
    listLinear: 'read',
    listGitHubLabels: 'read',
    listGitHubAssignableUsers: 'read',
    loadGitHubDetail: 'read',
    loadGitLabDetail: 'read',
    loadLinearDetail: 'read',
    listProjects: 'read',
    listProjectViews: 'read',
    resolveProjectRef: 'read',
    projectTable: 'read',
    projectItemDetail: 'read',
    projectItemLabels: 'read',
    projectItemAssignableUsers: 'read',
    projectIssueTypes: 'read',
    updateProjectItem: 'mutation',
    addProjectComment: 'mutation',
    updateProjectComment: 'mutation',
    deleteProjectComment: 'mutation',
    updateProjectMetadata: 'mutation',
    updateProjectField: 'mutation',
    updateProjectIssueType: 'mutation',
    resolveProjectReviewThread: 'mutation',
    replyProjectReviewComment: 'mutation',
    addProjectConversationComment: 'mutation',
    requestProjectReviewers: 'mutation',
    rerunProjectChecks: 'mutation',
    mergeProjectPullRequest: 'mutation',
    refreshProjectChecks: 'read',
    setProjectFileViewed: 'mutation',
    loadProjectFileContents: 'read',
    addProjectInlineComment: 'mutation',
    updateHostedTaskStatus: 'mutation',
    updateHostedTaskMetadata: 'mutation',
    addHostedTaskComment: 'mutation',
    requestHostedTaskReviewers: 'mutation',
    resolveHostedTaskReviewThread: 'mutation',
    replyHostedTaskReviewComment: 'mutation',
    mergeHostedTaskReview: 'mutation',
    refreshHostedTaskChecks: 'read',
    rerunHostedTaskChecks: 'mutation',
    setHostedTaskFileViewed: 'mutation',
    loadHostedTaskFileContents: 'read',
    addHostedTaskInlineComment: 'mutation',
    connectLinear: 'mutation',
    listLinearTeams: 'read',
    listLinearTeamStates: 'read',
    selectLinearWorkspace: 'mutation',
    updateLinearIssueState: 'mutation',
    addLinearIssueComment: 'mutation',
    loadLinearIssue: 'read',
    createLinearSubIssue: 'mutation',
    createLinearIssue: 'mutation',
    createProviderIssue: 'mutation',
    updateIssueSource: 'mutation'
  },
  provider: {
    review: 'read',
    reviewCreationEligibility: 'read',
    reviewCreate: 'mutation',
    reviewGenerateFields: 'mutation',
    reviewDiff: 'read',
    reviewQuery: 'read',
    mutateReview: 'mutation',
    manageReview: 'mutation',
    submitReview: 'mutation'
  },
  browser: {
    subscribe: 'subscription',
    navigate: 'mutation',
    back: 'mutation',
    forward: 'mutation',
    reload: 'mutation',
    dialog: 'mutation',
    pointer: 'mutation',
    keyboard: 'mutation'
  },
  account: {
    snapshot: 'read',
    select: 'mutation',
    resetCreditCapability: 'read',
    consumeResetCredit: 'mutation',
    subscribe: 'subscription'
  },
  agentHistory: {
    snapshot: 'read',
    preview: 'read',
    resume: 'mutation'
  },
  settings: {
    snapshot: 'read',
    update: 'mutation'
  },
  speech: {
    subscribe: 'subscription',
    setup: 'read',
    downloadModel: 'mutation',
    deleteModel: 'mutation',
    configure: 'mutation',
    start: 'mutation',
    stop: 'mutation',
    cancel: 'mutation'
  },
  native: {
    alert: 'mutation',
    hapticSelection: 'mutation',
    hapticFeedback: 'mutation',
    clipboardAvailability: 'read',
    clipboardWrite: 'mutation',
    openExternal: 'mutation',
    terminalPreferences: 'read',
    terminalAccessoryPreferences: 'read',
    terminalCustomKeysUpdate: 'mutation',
    terminalTextScaleUpdate: 'mutation',
    sessionChatDraftRead: 'read',
    sessionChatDraftWrite: 'mutation'
  },
  nativeChat: {
    read: 'read',
    subscribe: 'subscription',
    sendMessage: 'mutation',
    prepareCommit: 'mutation',
    respond: 'mutation',
    stop: 'mutation',
    attachImage: 'mutation',
    pasteImages: 'mutation',
    releaseImages: 'mutation',
    pendingRead: 'read',
    pendingWrite: 'mutation',
    fileSearch: 'read',
    openFile: 'mutation',
    readability: 'read'
  },
  navigation: {
    route: 'mutation',
    reconnect: 'mutation',
    removeHost: 'mutation'
  }
} as const satisfies Record<string, Record<string, MobileWebBridgeOperationKind>>

/** Capability names come from the operation table so a capability cannot exist in one and not the
 * other. */
export type MobileWebBridgeCapability = keyof typeof MOBILE_WEB_BRIDGE_OPERATIONS

export const MobileWebBridgeCapabilitySchema = z.enum(
  Object.keys(MOBILE_WEB_BRIDGE_OPERATIONS) as [
    MobileWebBridgeCapability,
    ...MobileWebBridgeCapability[]
  ]
)

/** Operation names a page may request for one capability. Keeps request clients from naming an
 * operation the shell never granted. Distributes so the default parameter still spans every
 * capability instead of intersecting their key sets. */
export type MobileWebBridgeOperationName<
  TCapability extends MobileWebBridgeCapability = MobileWebBridgeCapability
> = TCapability extends MobileWebBridgeCapability
  ? keyof (typeof MOBILE_WEB_BRIDGE_OPERATIONS)[TCapability] & string
  : never

export function isMobileWebBridgeOperation(
  capability: MobileWebBridgeCapability,
  operation: string
): boolean {
  return Object.hasOwn(MOBILE_WEB_BRIDGE_OPERATIONS[capability], operation)
}
