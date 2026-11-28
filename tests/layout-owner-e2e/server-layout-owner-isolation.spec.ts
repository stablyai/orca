import { expect, test } from '@stablyai/playwright-test'
import { LAYOUT_INTENTS_RUNTIME_CAPABILITY } from '../../src/shared/workspace-layout/published-layout/layout-intents-capability'
import {
  cliClient,
  orcadNodeExecutable,
  startHeadlessOracleHost,
  type HeadlessHostKind
} from './helpers/headless-layout-oracle-hosts'

// What a desktop on the new layout path passes to every process it starts; an empty value is unset.
const DESKTOP_ON_ENV = { ORCA_LAYOUT_OWNER: 'main', ORCA_LAYOUT_OWNER_RESOLVED: 'main' }

async function advertisesLayoutIntents(
  kind: HeadlessHostKind,
  serverSetting: string
): Promise<boolean> {
  const host = await startHeadlessOracleHost(kind, {
    ...DESKTOP_ON_ENV,
    ORCA_SERVER_LAYOUT_OWNER: serverSetting
  })
  try {
    const status = await cliClient(host).call<{ capabilities?: string[] }>('status.get')
    const capabilities = status.result.capabilities ?? []
    expect(capabilities.length).toBeGreaterThan(0)
    return capabilities.includes(LAYOUT_INTENTS_RUNTIME_CAPABILITY)
  } finally {
    await host.dispose()
  }
}

for (const kind of ['orcad', 'electron'] as const) {
  test(`a desktop on the new layout path never flips the ${kind} server it starts`, async () => {
    test.skip(
      kind === 'orcad' && !orcadNodeExecutable(),
      'out/orcad is not built (pnpm build:orcad)'
    )
    test.setTimeout(240_000)
    expect(await advertisesLayoutIntents(kind, '')).toBe(false)
    // The server's own setting still turns it on, so the absence above is the setting, not the probe.
    expect(await advertisesLayoutIntents(kind, 'main')).toBe(true)
  })
}
