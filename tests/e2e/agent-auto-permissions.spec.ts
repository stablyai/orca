import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('global Auto syncs native defaults only for supporting agents and persists', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store is unavailable')
    }
    return store.getState().updateSettingsOrThrow({ nativeChatPermissionMode: 'accept-edits' })
  })
  await orcaPage.getByRole('button', { name: 'Settings', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Agents', exact: true }).click()
  const group = orcaPage.getByRole('radiogroup', { name: 'Agent Permissions' })
  const others = orcaPage.getByRole('radiogroup', { name: 'Permissions for other agents' })
  const readArgs = () =>
    orcaPage.evaluate(async () => {
      const settings = await window.api.settings.get()
      return {
        claude: settings.agentDefaultArgs?.claude,
        codex: settings.agentDefaultArgs?.codex,
        gemini: settings.agentDefaultArgs?.gemini,
        native: settings.nativeChatPermissionMode,
        claudeNative: settings.agentNativeChatPermissionModes?.claude,
        codexNative: settings.agentNativeChatPermissionModes?.codex,
        grokNative: settings.agentNativeChatPermissionModes?.grok
      }
    })

  await group.getByRole('radio', { name: 'Yolo', exact: true }).click()
  await expect(others).toHaveCount(0)
  await group.getByRole('radio', { name: 'Auto', exact: true }).click()
  await expect(group.getByRole('radio', { name: 'Auto', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(others.getByRole('radio', { name: 'Yolo', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect.poll(readArgs).toEqual({
    claude: '--permission-mode auto',
    codex: '--approve-for-me',
    gemini: '--yolo',
    native: 'full-access',
    claudeNative: 'auto',
    codexNative: 'auto',
    grokNative: undefined
  })

  await others.getByRole('radio', { name: 'Manual', exact: true }).click()
  await expect.poll(readArgs).toEqual({
    claude: '--permission-mode auto',
    codex: '--approve-for-me',
    gemini: '',
    native: 'full-access',
    claudeNative: 'auto',
    codexNative: 'auto',
    grokNative: 'ask'
  })

  await orcaPage.reload()
  await orcaPage.waitForFunction(() => Boolean(window.__store))
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(group.getByRole('radio', { name: 'Auto', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(others.getByRole('radio', { name: 'Manual', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect.poll(readArgs).toMatchObject({
    native: 'full-access',
    claudeNative: 'auto',
    codexNative: 'auto',
    grokNative: 'ask'
  })

  await group.getByRole('radio', { name: 'Manual', exact: true }).click()
  await expect.poll(readArgs).toEqual({
    claude: '',
    codex: '',
    gemini: '',
    native: 'ask',
    claudeNative: undefined,
    codexNative: undefined,
    grokNative: undefined
  })
})
