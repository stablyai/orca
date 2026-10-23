import type { RuntimeEnvironmentStatus } from '../../src/shared/runtime-host-status'
import type { ProviderRateLimits } from '../../src/shared/rate-limit-types'
import type { SshConnectionState } from '../../src/shared/ssh-types'
import { RUNTIME_PROTOCOL_VERSION } from '../../src/shared/protocol-version'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

const HOST_ID = 'status-bar-recovery-host'
const COUNTS = [0, 1, 2, 9, 10, 99, 100, 120]
const CONDITIONS = [
  'checking',
  'reconnecting',
  'disconnected',
  'access-revoked',
  'incompatible'
] as const

type Condition = (typeof CONDITIONS)[number]

function hostStatus(condition: Condition): RuntimeEnvironmentStatus {
  if (condition === 'access-revoked' || condition === 'incompatible') {
    return {
      status: null,
      checkedAt: 1,
      snapshot: {
        environmentId: HOST_ID,
        pairingRevision: 1,
        sequence: 1,
        checkedAt: 1,
        status: null,
        verification: 'blocked',
        blockedReason: condition,
        transport: 'connecting'
      }
    }
  }
  return {
    status: null,
    checkedAt: 1,
    snapshot: {
      environmentId: HOST_ID,
      pairingRevision: 1,
      sequence: 1,
      checkedAt: 1,
      status: null,
      verification: condition === 'checking' ? 'checking' : 'unavailable',
      transport: condition === 'reconnecting' ? 'disconnected' : 'unknown'
    }
  }
}

test('remote host counts and actionable attention preserve rendered status-bar geometry', async ({
  orcaPage: page
}, testInfo) => {
  await page.setViewportSize({ width: 1800, height: 800 })
  await page.waitForFunction(() => window.__store?.getState().settings != null)
  await page.evaluate((hostId) => {
    const store = window.__store
    if (!store) {
      throw new Error('store unavailable')
    }
    const limits = (provider: ProviderRateLimits['provider']): ProviderRateLimits => ({
      provider,
      session: { usedPercent: 25, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      status: 'ok',
      updatedAt: Date.now(),
      error: null
    })
    store.setState({
      statusBarVisible: true,
      statusBarUsageMode: 'verbose',
      detectedAgentIds: null,
      statusBarItems: [
        'claude',
        'codex',
        'gemini',
        'antigravity',
        'opencode-go',
        'kimi',
        'minimax',
        'grok',
        'cursor',
        'zcode',
        'ports',
        'ssh'
      ],
      statusBarCompactChangeNoticeDismissed: true,
      usagePercentageDisplayChangeNoticeDismissed: true,
      rateLimits: {
        ...store.getState().rateLimits,
        claude: limits('claude'),
        codex: limits('codex'),
        gemini: limits('gemini'),
        antigravity: limits('antigravity'),
        opencodeGo: limits('opencode-go'),
        kimi: limits('kimi'),
        minimax: limits('minimax'),
        grok: limits('grok'),
        cursor: limits('cursor'),
        zcode: limits('zcode')
      },
      sshTargetLabels: new Map(
        Array.from({ length: 120 }, (_, index) => [`status-host-${index}`, `host-${index}`])
      ),
      sshConnectionStates: new Map(),
      runtimeEnvironments: [
        {
          id: hostId,
          name: 'build-server',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: hostId,
          endpoints: [],
          preferredEndpointId: hostId
        }
      ],
      runtimeStatusByEnvironmentId: new Map(),
      hydrateRuntimeEnvironmentStatuses: async () => undefined
    })
  }, HOST_ID)
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const trigger = page.getByRole('button', { name: 'Remote host connection status', exact: true })
  const attention = trigger.locator('span.text-destructive')
  const measureTrigger = () =>
    trigger.evaluate((button) => {
      const bounds = button.getBoundingClientRect()
      return {
        x: bounds.x,
        width: bounds.width,
        neighbors: [button.previousElementSibling, button.nextElementSibling].map(
          (node) => node?.getBoundingClientRect().x ?? 0
        )
      }
    })
  await expect(trigger).toBeVisible()
  const measurements: { theme: string; viewport: number; density: string; width: number }[] = []

  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (value) => document.documentElement.classList.toggle('dark', value === 'dark'),
      theme
    )
    const themeDensities = new Set<string>()
    for (const viewport of [1800, 900, 700, 600, 500, 440, 400]) {
      await page.setViewportSize({ width: viewport, height: 800 })
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame)
        await new Promise(requestAnimationFrame)
      })
      const density = await trigger.evaluate((button) =>
        button.querySelector('.lucide-monitor-smartphone')
          ? 'icon-only'
          : button.textContent?.includes('Needs attention')
            ? 'full'
            : 'compact'
      )
      if (themeDensities.has(density)) {
        continue
      }
      themeDensities.add(density)
      const baseline = await measureTrigger()
      measurements.push({ theme, viewport, density, width: baseline.width })
      for (const condition of CONDITIONS) {
        for (const count of COUNTS) {
          await page.evaluate(
            ({ count, hostId, status }) => {
              const store = window.__store
              if (!store) {
                throw new Error('store unavailable')
              }
              store.setState({
                sshConnectionStates: new Map(
                  Array.from({ length: 120 }, (_, index): [string, SshConnectionState] => {
                    const targetId = `status-host-${index}`
                    return [
                      targetId,
                      {
                        targetId,
                        status: index < count ? 'connected' : 'disconnected',
                        error: null,
                        reconnectAttempt: 0
                      }
                    ]
                  })
                ),
                runtimeStatusByEnvironmentId: new Map([[hostId, status]])
              })
            },
            { count, hostId: HOST_ID, status: hostStatus(condition) }
          )
          const blocked = condition === 'access-revoked' || condition === 'incompatible'
          await expect(trigger).toHaveAttribute(
            'aria-description',
            blocked
              ? `Connected hosts: ${count}. Hosts needing attention: 1.`
              : `Connected hosts: ${count}.`
          )
          await expect(
            trigger
              .locator('span:not([aria-hidden])')
              .filter({ hasText: new RegExp(`^${count} ${count === 1 ? 'host' : 'hosts'}$`) })
          ).toBeVisible()
          await expect(attention).toBeVisible({ visible: blocked })
          await expect(trigger.locator('.animate-spin')).toHaveCount(0)
          const current = await measureTrigger()
          expect(
            Math.abs(current.width - baseline.width),
            `${theme}/${density}/${count}/${condition}: width`
          ).toBeLessThanOrEqual(0.5)
          expect(
            Math.abs(current.x - baseline.x),
            `${theme}/${density}/${count}/${condition}: x`
          ).toBeLessThanOrEqual(0.5)
          current.neighbors.forEach((x, index) =>
            expect(Math.abs(x - baseline.neighbors[index])).toBeLessThanOrEqual(0.5)
          )
        }
      }
      const screenshotPath = testInfo.outputPath(`remote-hosts-${theme}-${density}.png`)
      await page.screenshot({ path: screenshotPath })
      await testInfo.attach(`remote-hosts-${theme}-${density}`, {
        path: screenshotPath,
        contentType: 'image/png'
      })
    }
    expect([...themeDensities].sort()).toEqual(['compact', 'full', 'icon-only'])
  }
  await testInfo.attach('remote-host-trigger-widths', {
    body: JSON.stringify(measurements, null, 2),
    contentType: 'application/json'
  })

  await page.setViewportSize({ width: 1800, height: 800 })
  await page.evaluate(
    ({ hostId, status }) => {
      window.__store?.setState({ runtimeStatusByEnvironmentId: new Map([[hostId, status]]) })
    },
    { hostId: HOST_ID, status: hostStatus('access-revoked') }
  )
  await trigger.focus()
  await trigger.press('Enter')
  await expect(page.getByText('Access revoked', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(page.getByText('Access revoked', { exact: true })).toBeVisible()
  await page.getByText('Re-pair…', { exact: true }).first().click()
  await expect(page.getByRole('dialog', { name: 'Re-pair build-server' })).toBeVisible()
  await page.keyboard.press('Escape')

  await page.evaluate(
    ({ hostId, version }) => {
      window.__store?.setState({
        runtimeStatusByEnvironmentId: new Map([
          [
            hostId,
            {
              status: {
                runtimeId: hostId,
                runtimeProtocolVersion: version,
                rendererGraphEpoch: 1,
                graphStatus: 'ready',
                authoritativeWindowId: 1,
                desktopWindowStatus: 'available',
                liveTabCount: 0,
                liveLeafCount: 0
              },
              checkedAt: 2
            }
          ]
        ])
      })
    },
    { hostId: HOST_ID, version: RUNTIME_PROTOCOL_VERSION }
  )
  await expect(attention).toBeHidden()
  await expect(trigger).toHaveAttribute('aria-description', 'Connected hosts: 121.')
})
