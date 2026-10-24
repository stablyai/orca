import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('global Auto preserves other agents’ choices and the single permission setting persists', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('button', { name: 'Settings', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Agents', exact: true }).click()
  const group = orcaPage.getByRole('radiogroup', { name: 'Agent Permissions' })
  const others = orcaPage.getByRole('radiogroup', { name: 'Permissions for other agents' })
  const readPermissions = () =>
    orcaPage.evaluate(async () => {
      const settings = await window.api.settings.get()
      return {
        default: settings.agentPermissionDefault,
        claude: settings.agentPermissionOverrides?.claude ?? settings.agentPermissionDefault,
        codex: settings.agentPermissionOverrides?.codex ?? settings.agentPermissionDefault,
        grok: settings.agentPermissionOverrides?.grok ?? settings.agentPermissionDefault
      }
    })

  await group.getByRole('radio', { name: 'Full access', exact: true }).click()
  await expect(others).toHaveCount(0)
  await group.getByRole('radio', { name: 'Approve for me', exact: true }).click()
  await expect(group.getByRole('radio', { name: 'Approve for me', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(others.getByRole('radio', { name: 'Full access', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect.poll(readPermissions).toEqual({
    default: 'auto',
    claude: 'auto',
    codex: 'auto',
    grok: 'full-access'
  })

  await others.getByRole('radio', { name: 'Own settings', exact: true }).click()
  await expect.poll(readPermissions).toEqual({
    default: 'auto',
    claude: 'auto',
    codex: 'auto',
    grok: 'own'
  })

  await orcaPage.reload()
  await orcaPage.waitForFunction(() => Boolean(window.__store))
  await waitForSessionReady(orcaPage)
  await orcaPage.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(group.getByRole('radio', { name: 'Approve for me', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect(others.getByRole('radio', { name: 'Own settings', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  )
  await expect.poll(readPermissions).toEqual({
    default: 'auto',
    claude: 'auto',
    codex: 'auto',
    grok: 'own'
  })

  await group.getByRole('radio', { name: 'Own settings', exact: true }).click()
  await expect.poll(readPermissions).toEqual({
    default: 'own',
    claude: 'own',
    codex: 'own',
    grok: 'own'
  })
})
