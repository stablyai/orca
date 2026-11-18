import { useAppStore } from '../../store'

export function registerOrcaProfileAuthIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api.orcaProfiles
  if (typeof api?.onAuthStatusChanged === 'function') {
    unsubs.push(
      api.onAuthStatusChanged(() => {
        void useAppStore.getState().fetchOrcaProfileAuthStatus()
      })
    )
  }
  if (typeof api?.onSignInProgressChanged === 'function') {
    // Why: a sign-in can already be in flight when this window loads; a later event or teardown wins.
    let ignoreSnapshot = false
    const unsubscribe = api.onSignInProgressChanged((progress) => {
      ignoreSnapshot = true
      useAppStore.setState({ orcaProfileSignInProgress: progress })
    })
    unsubs.push(() => {
      ignoreSnapshot = true
      unsubscribe()
    })
    void Promise.resolve()
      .then(() => api.signInProgress())
      .then((progress) => {
        if (!ignoreSnapshot) {
          useAppStore.setState({ orcaProfileSignInProgress: progress ?? null })
        }
      })
      .catch(() => {})
  }
}
