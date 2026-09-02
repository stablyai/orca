export type BranchCompareOidResult = { ok: true; oid: string } | { ok: false; error: unknown }

type BranchCompareHeadReaders = {
  readCompareRef: () => Promise<string>
  resolveBaseRef: () => Promise<string>
  readHeadOid: () => Promise<string>
  readBaseOid: (resolvedBaseRef: string) => Promise<string>
}

export type BranchCompareHead = {
  compareRef: string
  resolvedBaseRef: string
  headOidResult: BranchCompareOidResult
  baseOidResult: BranchCompareOidResult
}

function settleOid(read: Promise<string>): Promise<BranchCompareOidResult> {
  return read.then(
    (oid) => ({ ok: true as const, oid }),
    (error) => ({ ok: false as const, error })
  )
}

export async function readBranchCompareHead(
  readers: BranchCompareHeadReaders
): Promise<BranchCompareHead> {
  const compareRefPromise = readers.readCompareRef()
  const resolvedBaseRefPromise = readers.resolveBaseRef()
  const headOidResultPromise = settleOid(readers.readHeadOid())
  const baseOidResultPromise = resolvedBaseRefPromise.then((resolvedBaseRef) =>
    settleOid(readers.readBaseOid(resolvedBaseRef))
  )
  const [compareRef, resolvedBaseRef, headOidResult, baseOidResult] = await Promise.all([
    compareRefPromise,
    resolvedBaseRefPromise,
    headOidResultPromise,
    baseOidResultPromise
  ])
  return { compareRef, resolvedBaseRef, headOidResult, baseOidResult }
}
