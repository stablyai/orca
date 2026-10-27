/** Only a boundary proved for this image can suppress subsequent replayed output. */
export function provenSpawnResponse<
  Result extends {
    startupCwdSource?: unknown
    snapshotSeq?: number
    snapshotKittyKeyboardFlags?: number
  }
>(result: Result, provedSnapshotSeq?: number) {
  const { startupCwdSource: _source, ...response } = result
  const snapshotSeq = provedSnapshotSeq ?? result.snapshotSeq
  return {
    ...response,
    ...(provedSnapshotSeq !== undefined ? { snapshotSeq: provedSnapshotSeq } : {}),
    ...(typeof snapshotSeq === 'number' ? {} : { snapshotKittyKeyboardFlags: undefined })
  }
}
