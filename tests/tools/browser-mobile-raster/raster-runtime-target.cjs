function parseRasterReadyJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    // JSON.parse errors can quote the readiness file's credentials.
    throw new Error('Invalid readiness JSON')
  }
}

async function verifyRasterRuntimeTarget({
  ready,
  userData,
  RuntimeClient,
  decodePairingOffer,
  getCliStatus,
  sendRemoteRuntimeRequest
}) {
  if (
    typeof ready?.runtimeId !== 'string' ||
    !ready.runtimeId.trim() ||
    typeof ready?.pairing?.url !== 'string' ||
    !ready.pairing.url.trim()
  ) {
    throw new Error('Invalid readiness runtime identity or pairing')
  }
  let pairing
  try {
    pairing = decodePairingOffer(ready.pairing.url)
  } catch {
    throw new Error('Invalid readiness pairing')
  }
  const local = await getCliStatus(userData)
  if (local?.ok !== true || local.result?.runtime?.runtimeId !== ready.runtimeId) {
    throw new Error('Local runtime identity does not match readiness')
  }
  const remote = await sendRemoteRuntimeRequest(pairing, 'status.get', {}, 10000)
  if (remote?.ok !== true || remote.result?.runtimeId !== ready.runtimeId) {
    throw new Error('Paired runtime identity does not match readiness')
  }
  return {
    pairing,
    // Explicit nulls prevent inherited pairing/environment selectors overriding userData.
    client: new RuntimeClient(userData, 10000, null, null)
  }
}

module.exports = { parseRasterReadyJson, verifyRasterRuntimeTarget }
