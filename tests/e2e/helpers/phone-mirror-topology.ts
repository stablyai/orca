import type { TestInfo } from '@stablyai/playwright-test'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './headless-paired-runtime-host'
import {
  createDesktopMobilePairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './paired-electron-client'
import { pairMobileClient, type PairedMobileClient } from './paired-mobile-client'

export type PhoneMirrorTopology<TDesktop> = {
  /** Headless `orca serve`. */
  host: HeadlessPairedRuntimeHost
  /** Desktop paired to `host` as a client; null when the phone pairs with the host directly. */
  desktop: TDesktop
  phone: PairedMobileClient
  /**
   * Tears down phone, desktop, then host; every step runs even if an earlier one throws. Never
   * throws, so it cannot replace a test failure: teardown errors become a `teardown-error` attachment.
   */
  dispose: () => Promise<void>
}

type PhoneMirrorTopologyOptions = {
  /** Lets `host.restartServeProcess` reclaim the same port. */
  pinnedServePort?: boolean
}

/**
 * The phone-mirror test topology: a serve host, optionally a desktop paired to it, and a phone
 * paired with the desktop (the mirror) or directly with the host.
 */
export function launchPhoneMirrorTopology(
  options: PhoneMirrorTopologyOptions & { phoneTo: 'desktop' },
  testInfo: TestInfo
): Promise<PhoneMirrorTopology<PairedElectronClient>>
export function launchPhoneMirrorTopology(
  options: PhoneMirrorTopologyOptions & { phoneTo: 'host' },
  testInfo: TestInfo
): Promise<PhoneMirrorTopology<null>>
export async function launchPhoneMirrorTopology(
  options: PhoneMirrorTopologyOptions & { phoneTo: 'desktop' | 'host' },
  testInfo: TestInfo
): Promise<PhoneMirrorTopology<PairedElectronClient | null>> {
  const cleanups: (() => void | Promise<void>)[] = []
  const runCleanups = async (): Promise<unknown[]> => {
    const failures: unknown[] = []
    for (const cleanup of cleanups.splice(0).toReversed()) {
      try {
        await cleanup()
      } catch (error) {
        failures.push(error)
      }
    }
    return failures
  }
  try {
    const host = await launchHeadlessPairedRuntimeHost({
      pairingScope: options.phoneTo === 'host' ? 'mobile' : 'runtime',
      pinnedServePort: options.pinnedServePort
    })
    cleanups.push(host.dispose)
    let desktop: PairedElectronClient | null = null
    if (options.phoneTo === 'desktop') {
      const launched = await launchPairedElectronClient(host.offer, testInfo, 'mirror-desktop')
      cleanups.push(launched.dispose)
      desktop = launched
    }
    const phone = pairMobileClient(
      desktop ? await createDesktopMobilePairingOffer(desktop.page) : host.offer
    )
    cleanups.push(phone.dispose)
    const dispose = async (): Promise<void> => {
      const failures = await runCleanups()
      if (failures.length > 0) {
        await testInfo.attach('teardown-error', { body: failures.map(String).join('\n') })
      }
    }
    return { host, desktop, phone, dispose }
  } catch (error) {
    const failures = await runCleanups()
    if (failures.length > 0) {
      throw new AggregateError([error, ...failures], 'Phone mirror startup and cleanup failed')
    }
    throw error
  }
}
