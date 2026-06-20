import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BROWSER_PASSWORD_MESSAGE_PREFIX,
  isBrowserPasswordBridgeEvent,
  type BrowserCredentialEntry,
  type BrowserPasswordBridgeEvent,
  type BrowserPasswordBridgeField,
  type BrowserPasswordCaptureEvent,
  type BrowserPasswordDetectEvent
} from '../../../../../shared/browser-credential-types'

export function parsePasswordBridgeMessage(
  message: string,
  token: string
): BrowserPasswordBridgeEvent | null {
  const prefix = `${BROWSER_PASSWORD_MESSAGE_PREFIX}${token}:`
  if (!message.startsWith(prefix)) {
    return null
  }
  try {
    const parsed = JSON.parse(message.slice(prefix.length))
    return isBrowserPasswordBridgeEvent(parsed) ? parsed : null
  } catch {
    return null
  }
}

type Webview = Electron.WebviewTag

export function usePasswordAutofill(opts: {
  webview: Webview | null
  browserTabId: string | null
  token: string
  enabled: boolean
}) {
  const { webview, browserTabId, token, enabled } = opts
  const [detect, setDetect] = useState<BrowserPasswordDetectEvent | null>(null)
  const [matchesByFieldId, setMatchesByFieldId] = useState<
    Record<string, BrowserCredentialEntry[]>
  >({})
  const [pendingCapture, setPendingCapture] = useState<{
    origin: string
    username: string
    isUpdate: boolean
  } | null>(null)
  // Transient secret — the captured password lives ONLY here, never in React state, never returned.
  const captureSecretRef = useRef<BrowserPasswordCaptureEvent | null>(null)

  useEffect(() => {
    if (!webview || !enabled) {
      return undefined
    }
    const handler = (e: Electron.ConsoleMessageEvent): void => {
      const event = parsePasswordBridgeMessage(e.message, token)
      if (!event) {
        return
      }
      if (event.type === 'detect') {
        setDetect(event)
        void window.api.browser.credentials.matchesForOrigin(event.origin).then((matches) => {
          const byField: Record<string, BrowserCredentialEntry[]> = {}
          event.fields.forEach((f: BrowserPasswordBridgeField) => {
            byField[f.fieldId] = matches
          })
          setMatchesByFieldId(byField)
        })
      } else {
        // Hold the secret only in a ref; classify against the vault, never store the password in state.
        captureSecretRef.current = event
        void window.api.browser.credentials.matchesForOrigin(event.origin).then((matches) => {
          const isUpdate = matches.some((m) => m.username === event.username)
          setPendingCapture({ origin: event.origin, username: event.username, isUpdate })
        })
      }
    }
    webview.addEventListener('console-message', handler)
    return () => {
      webview.removeEventListener('console-message', handler)
    }
  }, [webview, enabled, token])

  const fillField = useCallback(
    (fieldId: string, entryId: string) => {
      if (!browserTabId) {
        return Promise.resolve(false)
      }
      return window.api.browser.credentials.fill({ browserTabId, entryId, fieldId })
    },
    [browserTabId]
  )

  const confirmSave = useCallback(async () => {
    const secret = captureSecretRef.current
    if (!secret) {
      return
    }
    await window.api.browser.credentials.save({
      origin: secret.origin,
      username: secret.username,
      password: secret.password
    })
    captureSecretRef.current = null
    setPendingCapture(null)
  }, [])

  const dismissCapture = useCallback(() => {
    captureSecretRef.current = null
    setPendingCapture(null)
  }, [])

  return { detect, matchesByFieldId, pendingCapture, fillField, confirmSave, dismissCapture }
}
