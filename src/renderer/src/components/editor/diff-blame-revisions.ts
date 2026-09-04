import { GIT_BLAME_HEAD_REVISION } from '../../../../shared/git-blame'
import type { DiffSource } from '@/store/slices/editor/types/open-file'

export type DiffBlameRevisionPair = {
  originalRevision?: string
  modifiedRevision?: string
}

export function getFileDiffBlameRevisions(file: {
  diffSource?: DiffSource
  commitCompare?: { commitOid: string; parentOid: string | null } | null
  branchCompare?: {
    mergeBase: string | null
    baseOid: string | null
    headOid: string | null
  } | null
}): DiffBlameRevisionPair {
  if (file.diffSource === 'commit' || file.diffSource === 'combined-commit') {
    return {
      originalRevision: file.commitCompare?.parentOid ?? undefined,
      modifiedRevision: file.commitCompare?.commitOid
    }
  }
  if (file.diffSource === 'branch' || file.diffSource === 'combined-branch') {
    return {
      originalRevision: file.branchCompare?.mergeBase ?? file.branchCompare?.baseOid ?? undefined,
      modifiedRevision: file.branchCompare?.headOid ?? undefined
    }
  }
  return { originalRevision: GIT_BLAME_HEAD_REVISION, modifiedRevision: undefined }
}

export function getCombinedSectionBlameRevisions(args: {
  diffSource?: DiffSource
  sectionArea?: string
  commitCompare?: { commitOid: string; parentOid: string | null } | null
  branchCompare?: {
    mergeBase: string | null
    baseOid: string | null
    headOid: string | null
  } | null
}): DiffBlameRevisionPair {
  if (args.diffSource === 'combined-all' && args.sectionArea === undefined) {
    return getFileDiffBlameRevisions({
      diffSource: 'combined-branch',
      branchCompare: args.branchCompare
    })
  }
  return getFileDiffBlameRevisions({
    diffSource: args.diffSource,
    commitCompare: args.commitCompare,
    branchCompare: args.branchCompare
  })
}
