/** A window.api.ssh stub with no hosts, forwards or events, for IPC-event harnesses. */
export function createIdleSshApiStub() {
  return {
    listTargets: () => Promise.resolve([]),
    listPortForwards: () => Promise.resolve([]),
    listUnrestoredPortForwards: () => Promise.resolve([]),
    listDetectedPorts: () => Promise.resolve([]),
    getState: () => Promise.resolve(null),
    onStateChanged: () => () => {},
    onCredentialRequest: () => () => {},
    onPortForwardsChanged: () => () => {},
    onDetectedPortsChanged: () => () => {},
    onCredentialResolved: () => () => {}
  }
}
