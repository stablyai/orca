export const BITBUCKET_PR_MERGE_METHODS = ['merge_commit', 'squash', 'fast_forward'] as const

export type BitbucketPRMergeMethod = (typeof BITBUCKET_PR_MERGE_METHODS)[number]

export const BITBUCKET_PR_MERGE_METHOD_LABELS: Record<BitbucketPRMergeMethod, string> = {
  merge_commit: 'Create merge commit',
  squash: 'Squash and merge',
  fast_forward: 'Fast-forward merge'
}

export type BitbucketPRMergeMethodOption = {
  method: BitbucketPRMergeMethod
  label: string
}

export type BitbucketPRMergeMethodPresentation = {
  defaultMethod: BitbucketPRMergeMethod
  defaultLabel: string
  methods: BitbucketPRMergeMethodOption[]
}

export function resolveBitbucketPRMergeMethods(
  defaultMethod: BitbucketPRMergeMethod = 'merge_commit'
): BitbucketPRMergeMethodPresentation {
  const orderedMethods: BitbucketPRMergeMethod[] = [
    defaultMethod,
    ...BITBUCKET_PR_MERGE_METHODS.filter((m) => m !== defaultMethod)
  ]

  return {
    defaultMethod,
    defaultLabel: BITBUCKET_PR_MERGE_METHOD_LABELS[defaultMethod],
    methods: orderedMethods.map((method) => ({
      method,
      label: BITBUCKET_PR_MERGE_METHOD_LABELS[method]
    }))
  }
}
