import { useState } from 'react'
import { toast } from 'sonner'
import type { SshTarget } from '../../../../shared/ssh-types'
import { useAppStore } from '@/store'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { isSshTargetConnecting } from './ssh-target-action-state'

type TestOutcome = { ok: true } | { ok: false; message: string }

// Cap concurrent SSH sessions so Select All cannot dial the entire config at once.
const BULK_TEST_CONCURRENCY = 4

export function useSshTargetTests(): {
  testingIds: ReadonlySet<string>
  testOne: (targetId: string) => Promise<void>
  testMany: (targets: readonly SshTarget[]) => Promise<void>
  bulkTesting: boolean
} {
  const mountedRef = useMountedRef()
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [testingIds, setTestingIds] = useState<ReadonlySet<string>>(new Set())
  const [bulkTesting, setBulkTesting] = useState(false)

  const setTesting = (ids: readonly string[], testing: boolean): void => {
    if (!mountedRef.current) {
      return
    }
    setTestingIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) {
        if (testing) {
          next.add(id)
        } else {
          next.delete(id)
        }
      }
      return next
    })
  }

  const runTest = async (targetId: string): Promise<TestOutcome> => {
    setTesting([targetId], true)
    try {
      const result = await window.api.ssh.testConnection({ targetId })
      recordFeatureInteraction('ssh')
      return result.success
        ? { ok: true }
        : {
            ok: false,
            message:
              result.error ??
              translate('auto.components.settings.SshPane.0cda732f43', 'Connection test failed')
          }
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : translate('auto.components.settings.SshPane.68c13b4589', 'Test failed')
      }
    } finally {
      setTesting([targetId], false)
    }
  }

  const testOne = async (targetId: string): Promise<void> => {
    const outcome = await runTest(targetId)
    if (!mountedRef.current) {
      return
    }
    if (outcome.ok) {
      toast.success(
        translate('auto.components.settings.SshPane.81d08bcddf', 'Connection successful')
      )
    } else {
      toast.error(outcome.message)
    }
  }

  const testMany = async (targets: readonly SshTarget[]): Promise<void> => {
    if (bulkTesting) {
      return
    }
    // Connected/connecting hosts have nothing to test, matching the row action.
    const states = useAppStore.getState().sshConnectionStates
    const isLive = (target: SshTarget): boolean => {
      const status = states.get(target.id)?.status ?? 'disconnected'
      return status === 'connected' || isSshTargetConnecting(status)
    }
    const skippedConnected = targets.filter(isLive).length
    const queue = targets.filter((target) => !isLive(target) && !testingIds.has(target.id))
    setBulkTesting(true)
    const failed: { label: string; message: string }[] = []
    let passed = 0
    const worker = async (): Promise<void> => {
      for (let target = queue.shift(); target; target = queue.shift()) {
        const outcome = await runTest(target.id)
        if (outcome.ok) {
          passed += 1
        } else {
          failed.push({ label: target.label, message: outcome.message })
        }
      }
    }
    try {
      await Promise.all(Array.from({ length: BULK_TEST_CONCURRENCY }, worker))
    } finally {
      if (mountedRef.current) {
        setBulkTesting(false)
      }
    }
    if (!mountedRef.current || passed + failed.length + skippedConnected === 0) {
      return
    }
    const title = [
      passed > 0
        ? translate('auto.components.settings.sshBulkTest.passed', '{{count}} reachable', {
            count: passed
          })
        : null,
      failed.length > 0
        ? translate('auto.components.settings.sshBulkTest.failed', '{{count}} failed', {
            count: failed.length
          })
        : null,
      skippedConnected > 0
        ? translate(
            'auto.components.settings.sshBulkTest.alreadyConnected',
            '{{count}} already connected',
            { count: skippedConnected }
          )
        : null
    ]
      .filter((part): part is string => part !== null)
      .join(' · ')
    const description = failed.map(({ label, message }) => `${label}: ${message}`).join(' ')
    if (failed.length === 0) {
      toast.success(title)
    } else if (passed === 0) {
      toast.error(title, { description })
    } else {
      toast(title, { description })
    }
  }

  return { testingIds, testOne, testMany, bulkTesting }
}
