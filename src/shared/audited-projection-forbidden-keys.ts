// Fields that must NEVER appear on the audited task projection.
//
// SPLIT FROM audited-workflow-projection.ts so that module stays within its
// line budget without a max-lines suppression. This is pure data with no
// dependency on the builder, which is what makes the split clean rather than
// arbitrary — and keeping it in its own file makes each phase's additions to
// the denylist a visible, self-contained diff.
//
// Used by a denylist test that inspects the RUNTIME object, not just the
// compiled type, since a bug could still attach an extra field.

export const AUDITED_PROJECTION_FORBIDDEN_KEYS = [
  'prompt',
  'stdout',
  'stderr',
  'diff',
  'path',
  'worktreePath',
  'sourceRepoPath',
  'commandLine',
  'env',
  'sessionId',
  'baseCommit',
  'expectedTreeOid',
  'committedSha', // full form; only committedShaShort is allowed
  'auditApprovedTreeOid',
  'exception',
  'stack',
  // Phase 3 worktree identity — only worktreeReady/worktreeReasonCode may cross.
  'branchName',
  'worktreeId',
  'worktreeProvenanceId',
  'sourceRepoCommonDir',
  'intendedPath',
  'intendedBranch',
  // Phase 4 execution internals — only the three execution* fields may cross.
  // Agent output is the highest-risk field for embedded secrets and absolute
  // paths, so not even a path to the log directory is projected.
  'executionLogPath',
  'stdoutLog',
  'stderrLog',
  'argv',
  'settingsPath',
  'pid',
  'model',
  'nextStepPrompt',
  // Phase 5 plan-artifact / Codex-review internals. Only the metadata fields
  // and the bounded, sanitized planReviewSummary may cross. The plan BODY is
  // fetched on demand and is never attached to a projection; not even the
  // artifact's content hash crosses, since it is an authorization input.
  'planText',
  'planBody',
  'planArtifactPath',
  'artifactPath',
  'planArtifactSha256',
  'contentSha256',
  'codexArgv',
  'codexPrompt',
  'auditPrompt',
  'lastMessagePath',
  'reviewStdout',
  'reviewStderr',
  // Phase 6 coverage internals. Only the per-criterion covered/note pair and the
  // coverageAvailable boolean may cross; the run that produced them is an
  // internal identifier with no renderer use, and the raw stored blob shape is
  // not a projection contract.
  'coverageJson',
  'coverageRunId',
  'criterionRunId',
  // Phase 7 candidate internals. The tree OID is AUTHORIZATION identity — the
  // full value must never cross, and only the approved one crosses at all, as
  // the 12-char candidateIdShort. The temp index/object paths and the audit
  // prompt are internal to derivation and the launcher.
  'treeOid',
  'candidateTreeOid',
  'candidateId',
  'tempIndexPath',
  'gitObjectDirectory',
  'auditPromptText',
  // Phase 8 approval/commit internals. The approved tree OID is authorization
  // identity; the commit message is renderer-authored INPUT that travels
  // main-ward only and is never echoed back. The candidate store path and its
  // byte accounting describe on-disk secrets-bearing storage and never cross.
  'approvedTreeOid',
  'approvalId',
  'commitMessage',
  'messageFilePath',
  'intendedTreeOid',
  'intendedParent',
  'intendedMessageSha',
  'createdCommitSha',
  'materializedTreeOid',
  'verifiedTreeOid',
  'candidateStorePath',
  'storeBytes',
  'reservationId',
  // Phase 9 publish internals. The remote URL can carry a self-hosted host name
  // and, in a misconfigured repo, embedded credentials; the review URL likewise
  // names a host. The lease and the intended/pushed shas are full 40-hex identity
  // values — only publishedShaShort crosses. Provider error text is free text
  // produced by gh/glab and is dropped at the adapter boundary.
  'remoteName',
  'remoteUrl',
  'reviewUrl',
  'pushedSha',
  'publishedSha',
  'expectedRemoteSha',
  'intendedSha',
  'leaseValue',
  'pushStderr',
  'providerPayload',
  'providerError',
  // Phase 10 landing internals. The source repo path and its common dir name a
  // location on the user's disk outside the managed tree — the single most
  // sensitive path this feature touches, since it is the user's own workspace.
  // landed_sha / landed_base_sha are full 40-hex identity values; only
  // landedShaShort crosses. The intended base is the CAS operand and is
  // authorization identity, exactly like intendedParent.
  'landedSha',
  'landedBaseSha',
  'intendedBaseSha',
  'sourceRepoWorktreePath',
  'landAttemptId',
  'landStderr'
] as const
