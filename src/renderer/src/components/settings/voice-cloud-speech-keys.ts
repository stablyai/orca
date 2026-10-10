import { useCallback, useRef, useState } from 'react'
import type {
  CloudSpeechKeyStatus,
  CloudSpeechKeyTestResult,
  CloudSpeechProviderId
} from '../../../../shared/cloud-speech-providers'
import { describeSpeechIpcError } from './voice-speech-ipc-error'

export type CloudSpeechKeyTestState =
  | { status: 'testing' }
  | { status: 'done'; result: CloudSpeechKeyTestResult }

type ProviderRecord<T> = Partial<Record<CloudSpeechProviderId, T>>

export type CloudSpeechKeysController = {
  statusById: ProviderRecord<CloudSpeechKeyStatus>
  pendingById: ProviderRecord<boolean>
  testById: ProviderRecord<CloudSpeechKeyTestState>
  refresh: () => Promise<CloudSpeechKeyStatus[] | null>
  saveKey: (
    providerId: CloudSpeechProviderId,
    apiKey: string,
    verify: boolean
  ) => Promise<CloudSpeechKeyStatus>
  clearKey: (providerId: CloudSpeechProviderId) => Promise<CloudSpeechKeyStatus>
  testKey: (providerId: CloudSpeechProviderId) => Promise<void>
}

function withEntry<T>(
  record: ProviderRecord<T>,
  providerId: CloudSpeechProviderId,
  value: T | undefined
): ProviderRecord<T> {
  const next = { ...record }
  if (value === undefined) {
    delete next[providerId]
  } else {
    next[providerId] = value
  }
  return next
}

function sameKeyStatus(a: CloudSpeechKeyStatus | undefined, b: CloudSpeechKeyStatus): boolean {
  return (
    a !== undefined &&
    a.configured === b.configured &&
    a.hint === b.hint &&
    a.protection === b.protection
  )
}

/** Per-provider key status for the Voice pane; the key itself never comes back from main. */
export function useCloudSpeechKeys(): CloudSpeechKeysController {
  const [statusById, setStatusById] = useState<ProviderRecord<CloudSpeechKeyStatus>>({})
  const [pendingById, setPendingById] = useState<ProviderRecord<boolean>>({})
  const [testById, setTestById] = useState<ProviderRecord<CloudSpeechKeyTestState>>({})
  // Why: a test that resolves after the key was replaced or removed must not show a stale verdict.
  const testGenerationRef = useRef<ProviderRecord<number>>({})

  const forgetTest = useCallback((providerId: CloudSpeechProviderId): void => {
    testGenerationRef.current[providerId] = (testGenerationRef.current[providerId] ?? 0) + 1
    setTestById((prev) => withEntry(prev, providerId, undefined))
  }, [])

  const applyStatus = useCallback((status: CloudSpeechKeyStatus): void => {
    setStatusById((prev) => withEntry(prev, status.providerId, status))
  }, [])

  const refresh = useCallback(async (): Promise<CloudSpeechKeyStatus[] | null> => {
    try {
      const statuses = await window.api.speech.getCloudKeyStatuses()
      // Why: keep the previous object when nothing changed so a re-fetch does not re-render the pane.
      setStatusById((prev) =>
        statuses.length === Object.keys(prev).length &&
        statuses.every((status) => sameKeyStatus(prev[status.providerId], status))
          ? prev
          : Object.fromEntries(statuses.map((status) => [status.providerId, status]))
      )
      return statuses
    } catch {
      return null
    }
  }, [])

  const runPending = useCallback(
    async <T>(providerId: CloudSpeechProviderId, action: () => Promise<T>): Promise<T> => {
      setPendingById((prev) => withEntry(prev, providerId, true))
      try {
        return await action()
      } finally {
        setPendingById((prev) => withEntry(prev, providerId, undefined))
      }
    },
    []
  )

  const saveKey = useCallback(
    (providerId: CloudSpeechProviderId, apiKey: string, verify: boolean) =>
      runPending(providerId, async () => {
        const status = await window.api.speech.saveCloudKey(providerId, apiKey, verify)
        applyStatus(status)
        forgetTest(providerId)
        return status
      }),
    [applyStatus, forgetTest, runPending]
  )

  const clearKey = useCallback(
    (providerId: CloudSpeechProviderId) =>
      runPending(providerId, async () => {
        const status = await window.api.speech.clearCloudKey(providerId)
        applyStatus(status)
        forgetTest(providerId)
        return status
      }),
    [applyStatus, forgetTest, runPending]
  )

  const testKey = useCallback(async (providerId: CloudSpeechProviderId): Promise<void> => {
    const generation = (testGenerationRef.current[providerId] ?? 0) + 1
    testGenerationRef.current[providerId] = generation
    setTestById((prev) => withEntry(prev, providerId, { status: 'testing' }))
    let result: CloudSpeechKeyTestResult
    try {
      result = await window.api.speech.testCloudKey(providerId)
    } catch (error) {
      result = { ok: false, message: describeSpeechIpcError(error) }
    }
    if (testGenerationRef.current[providerId] === generation) {
      setTestById((prev) => withEntry(prev, providerId, { status: 'done', result }))
    }
  }, [])

  return { statusById, pendingById, testById, refresh, saveKey, clearKey, testKey }
}
