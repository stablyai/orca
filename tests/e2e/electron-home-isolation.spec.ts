import type { ElectronApplication } from '@stablyai/playwright-test'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

test.use({ seedTestRepo: false })

async function readElectronHomeState(electronApp: ElectronApplication) {
  return electronApp.evaluate(({ app }) => {
    const nodeOs = process.getBuiltinModule('node:os')
    return {
      appHome: app.getPath('home'),
      nodeHome: nodeOs.homedir(),
      userDataDir: process.env.ORCA_E2E_USER_DATA_DIR,
      home: process.env.HOME,
      userProfile: process.env.USERPROFILE,
      codexHome: process.env.CODEX_HOME,
      orcaCodexHome: process.env.ORCA_CODEX_HOME,
      realHomeFlag: process.env.ORCA_CODEX_SYSTEM_DEFAULT_REAL_HOME
    }
  })
}

test('isolates Electron and Codex from the developer home by default', async ({ electronApp }) => {
  const state = await readElectronHomeState(electronApp)
  const expectedHome = path.join(state.userDataDir!, 'home')

  expect(state.appHome).toBe(expectedHome)
  expect(state.nodeHome).toBe(expectedHome)
  expect(state.home).toBe(expectedHome)
  expect(state.userProfile).toBe(expectedHome)
  expect(state.codexHome).toBeUndefined()
  expect(state.orcaCodexHome).toBeUndefined()
  expect(state.realHomeFlag).toBe('0')
})

test.describe('sandboxed real-home routing', () => {
  test.use({ codexRealHomeEnabled: true })

  test('keeps flag-ON routing inside the disposable home', async ({ electronApp }) => {
    const state = await readElectronHomeState(electronApp)

    expect(state.appHome).toBe(path.join(state.userDataDir!, 'home'))
    expect(state.nodeHome).toBe(path.join(state.userDataDir!, 'home'))
    expect(state.realHomeFlag).toBe('1')
  })
})
