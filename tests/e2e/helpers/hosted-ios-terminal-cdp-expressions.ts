export const HOSTED_IOS_TERMINAL_CLIPBOARD_PASTE_CAPTURE = '__ORCA_CLIPBOARD_PASTE__'

export const hostedIosTerminalReadyExpression = `(() => {
  const focusTarget = document.querySelector(
    '[aria-label="Show keyboard for live terminal input"]'
  )
  const input = focusTarget?.parentElement?.querySelector('input')
  return focusTarget?.getAttribute('aria-disabled') !== 'true' &&
    input instanceof HTMLInputElement &&
    !input.readOnly
    ? 'ready'
    : 'missing'
})()`

export const hostedIosTerminalInputCaptureInstallExpression = `(() => {
  const bridge = window.OrcaNative
  if (!bridge || typeof bridge.postMessage !== 'function') return 'missing-bridge'
  if (Array.isArray(window.__orcaTerminalInputCapture)) return 'installed'
  const captured = []
  const original = bridge.postMessage.bind(bridge)
  const wrapped = (value) => {
    try {
      const message = JSON.parse(value)
      if (
        message?.type === 'request' &&
        message?.capability === 'terminal' &&
        message?.operation === 'input' &&
        typeof message?.payload?.data === 'string'
      ) {
        captured.push(message.payload.data)
      } else if (
        message?.type === 'request' &&
        message?.capability === 'terminal' &&
        message?.operation === 'clipboardPaste'
      ) {
        captured.push(btoa(${JSON.stringify(HOSTED_IOS_TERMINAL_CLIPBOARD_PASTE_CAPTURE)}))
      }
    } catch {}
    original(value)
  }
  window.__orcaTerminalInputCapture = captured
  bridge.postMessage = wrapped
  if (bridge.postMessage !== wrapped) window.OrcaNative = { postMessage: wrapped }
  return window.OrcaNative?.postMessage === wrapped ? 'installed' : 'not-wrapped'
})()`

export const hostedIosTerminalInputCaptureExpression = `(() => {
  const encoded = Array.isArray(window.__orcaTerminalInputCapture)
    ? window.__orcaTerminalInputCapture
    : []
  return encoded.map((value) => {
    const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  }).join('')
})()`
