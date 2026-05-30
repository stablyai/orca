import type { GitHubPRMergeMethod, GitHubPRMergeMethodSettings } from './types'

export const GITHUB_PR_MERGE_METHODS = ['squash', 'merge', 'rebase'] as const

export const GITHUB_PR_MERGE_METHOD_LABELS: Record<GitHubPRMergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create merge commit',
  rebase: 'Rebase and merge'
}

export type GitHubPRMergeMethodOption = {
  method: GitHubPRMergeMethod
  label: string
}

export type GitHubPRMergeMethodPresentation = {
  defaultMethod: GitHubPRMergeMethod
  defaultLabel: string
  methods: GitHubPRMergeMethodOption[]
}

function allMethodsAllowed(): Record<GitHubPRMergeMethod, boolean> {
  return {
    squash: true,
    merge: true,
    rebase: true
  }
}

export function mapGitHubDefaultMergeMethod(value: unknown): GitHubPRMergeMethod | null {
  switch (typeof value === 'string' ? value.toUpperCase() : '') {
    case 'MERGE':
      return 'merge'
    case 'SQUASH':
      return 'squash'
    case 'REBASE':
      return 'rebase'
    default:
      return null
  }
}

export function normalizeGitHubPRMergeMethodSettings(args: {
  defaultMethod: unknown
  mergeCommitAllowed: unknown
  rebaseMergeAllowed: unknown
  squashMergeAllowed: unknown
}): GitHubPRMergeMethodSettings | undefined {
  const allowedMethods = {
    squash: args.squashMergeAllowed === true,
    merge: args.mergeCommitAllowed === true,
    rebase: args.rebaseMergeAllowed === true
  }
  const defaultMethod = mapGitHubDefaultMergeMethod(args.defaultMethod)
  const firstAllowedMethod = GITHUB_PR_MERGE_METHODS.find((method) => allowedMethods[method])
  const resolvedDefault =
    defaultMethod && allowedMethods[defaultMethod]
      ? defaultMethod
      : (firstAllowedMethod ?? defaultMethod)
  if (!resolvedDefault) {
    return undefined
  }
  return {
    defaultMethod: resolvedDefault,
    allowedMethods
  }
}

export function resolveGitHubPRMergeMethods(
  settings?: GitHubPRMergeMethodSettings | null
): GitHubPRMergeMethodPresentation {
  const allowedMethods = settings?.allowedMethods ?? allMethodsAllowed()
  const firstAllowedMethod = GITHUB_PR_MERGE_METHODS.find((method) => allowedMethods[method])
  const defaultMethod =
    settings?.defaultMethod && allowedMethods[settings.defaultMethod]
      ? settings.defaultMethod
      : (firstAllowedMethod ?? 'squash')
  const orderedMethods = [
    defaultMethod,
    ...GITHUB_PR_MERGE_METHODS.filter((method) => method !== defaultMethod)
  ].filter((method) => allowedMethods[method])
  const methods = (orderedMethods.length > 0 ? orderedMethods : GITHUB_PR_MERGE_METHODS).map(
    (method) => ({
      method,
      label: GITHUB_PR_MERGE_METHOD_LABELS[method]
    })
  )
  return {
    defaultMethod,
    defaultLabel: GITHUB_PR_MERGE_METHOD_LABELS[defaultMethod],
    methods
  }
}
