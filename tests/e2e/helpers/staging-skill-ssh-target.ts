import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Page } from '@stablyai/playwright-test'

export type StagingSkillSshTarget = {
  host: string
  port: number
  username: string
  identityFile: string
}

export function stagingSkillSshTargetFromEnvironment(): StagingSkillSshTarget | null {
  const host = process.env.ORCA_E2E_SKILL_SSH_HOST?.trim()
  const username = process.env.ORCA_E2E_SKILL_SSH_USERNAME?.trim()
  const identityFile = process.env.ORCA_E2E_SKILL_SSH_IDENTITY_FILE?.trim()
  const configured = [host, username, identityFile].filter(Boolean).length
  if (configured === 0) {
    return null
  }
  if (configured !== 3 || !host || !username || !identityFile) {
    throw new Error('staging SSH requires host, username, and identity-file environment values')
  }
  const port = Number(process.env.ORCA_E2E_SKILL_SSH_PORT?.trim() || '22')
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error('staging SSH port is invalid')
  }
  if (!isAbsolute(identityFile) || !existsSync(identityFile)) {
    throw new Error('staging SSH identity file must be an existing absolute path')
  }
  return { host, port, username, identityFile }
}

export async function connectStagingSkillSshTarget(
  page: Page,
  target: StagingSkillSshTarget
): Promise<string> {
  return page.evaluate(async (target) => {
    const store = window.__store
    if (!store) {
      throw new Error('staging client store is unavailable')
    }
    const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
      void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
    })
    let targetId: string | null = null
    try {
      const { target: createdTarget } = await window.api.ssh.addTarget({
        target: {
          label: `Skill staging SSH ${Date.now()}`,
          ...target,
          identitiesOnly: true,
          relayGracePeriodSeconds: 1
        }
      })
      targetId = createdTarget.id
      const state = await window.api.ssh.connect({ targetId: createdTarget.id })
      if (!state || state.status !== 'connected') {
        throw new Error(`staging SSH target did not connect: ${state?.status ?? 'unavailable'}`)
      }
      store.getState().setSshConnectionState(createdTarget.id, state)
      const labels = new Map(store.getState().sshTargetLabels)
      labels.set(createdTarget.id, createdTarget.label)
      store.getState().setSshTargetLabels(labels)
      return createdTarget.id
    } catch (error) {
      if (targetId) {
        await window.api.ssh.removeTarget({ id: targetId }).catch(() => undefined)
      }
      throw error
    } finally {
      credentialUnsub()
    }
  }, target)
}

export async function removeStagingSkillSshTarget(page: Page, targetId: string): Promise<void> {
  await page.evaluate(async (targetId) => {
    await window.api.ssh.disconnect({ targetId }).catch(() => undefined)
    await window.api.ssh.removeTarget({ id: targetId }).catch(() => undefined)
  }, targetId)
}
