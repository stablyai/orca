/** Additive paired-runtime RPCs; older hosts fail closed with method_not_found. */
export const PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS = Object.freeze({
  preflightSource: 'pty.ownershipTransfer.preflightSource',
  grantSource: 'pty.ownershipTransfer.grantSource',
  statusSource: 'pty.ownershipTransfer.statusSource',
  prepareSource: 'pty.ownershipTransfer.prepareSource',
  replaySource: 'pty.ownershipTransfer.replaySource',
  commitSource: 'pty.ownershipTransfer.commitSource',
  publishSource: 'pty.ownershipTransfer.publishSource',
  inputSource: 'pty.ownershipTransfer.inputSource',
  retireInputSource: 'pty.ownershipTransfer.retireInputSource',
  attachSource: 'pty.ownershipTransfer.attachSource',
  rekeyReconnectSource: 'pty.ownershipTransfer.rekeyReconnectSource',
  controlSource: 'pty.ownershipTransfer.controlSource',
  abortSource: 'pty.ownershipTransfer.abortSource',
  acknowledgeOutputSource: 'pty.ownershipTransfer.acknowledgeOutputSource',
  streamSource: 'pty.ownershipTransfer.streamSource'
})

export const PTY_CAPTURED_DESTINATION_PREPARE_METHOD =
  'pty.ownershipTransfer.prepareCapturedDestination'
export const PTY_CAPTURED_DESTINATION_CAPABILITIES_METHOD =
  'pty.ownershipTransfer.capturedDestinationCapabilities'
export const PTY_CAPTURED_DESTINATION_ACTIVATION_METHOD =
  'pty.ownershipTransfer.inspectCapturedCatalogActivation'
export const PTY_CAPTURED_DESTINATION_OUTPUT_COVERAGE_METHOD =
  'pty.ownershipTransfer.inspectCapturedCatalogOutputCoverage'
export const PTY_CAPTURED_SOURCE_RETIREMENT_METHOD =
  'pty.ownershipTransfer.retireCapturedSourceDelivery'
