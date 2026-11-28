import { describe, expect, it } from 'vitest'
import { BotSchema, type Bot } from '../bot-types'
import { applyBotUpdates } from '../rpc-contract/bots-params'
import {
  BOT_BACKUP_MODEL_LIMIT,
  BotActiveBackupSchema,
  BotBackupModelsSchema,
  addBotBackupModel,
  effectiveBotSetup,
  normalizeBotBackupModels,
  rememberedBotBackupModels,
  removeBotBackupModel,
  reorderBotBackupModels,
  updateBotBackupModelEffort
} from './bot-backup-models'

function sampleBot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: 'bot-1',
    hostId: 'local',
    name: 'Release Scout',
    folder: 'release-scout',
    folderWorkspaceId: 'folder-1',
    avatar: null,
    paused: false,
    agent: 'claude',
    launch: { model: 'claude-sonnet-4-5' },
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: 'session-home',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

describe('bot-backup-models schemas and invariants', () => {
  it('enforces bounded order length, control-char rejection, and valid agent enum', () => {
    const nine = Array.from({ length: BOT_BACKUP_MODEL_LIMIT + 1 }, (_, index) => ({
      agent: 'codex' as const,
      model: `model-${index}`
    }))
    expect(BotBackupModelsSchema.safeParse({ automatic: true, order: nine }).success).toBe(false)
    expect(
      BotBackupModelsSchema.safeParse({
        automatic: true,
        order: [{ agent: 'codex', model: 'bad\u0000model' }]
      }).success
    ).toBe(false)
    expect(
      BotBackupModelsSchema.safeParse({
        automatic: true,
        order: [{ agent: 'codex', model: 'gpt-5-codex', options: { effort: 'high\n' } }]
      }).success
    ).toBe(false)
    expect(
      BotBackupModelsSchema.safeParse({
        automatic: true,
        order: [{ agent: 'unknown-agent', model: 'x' }]
      }).success
    ).toBe(false)
    expect(
      BotActiveBackupSchema.safeParse({
        target: { agent: 'codex', model: 'gpt-5-codex' },
        switchedAt: 1_700_000_000_000,
        primaryModel: 'claude-sonnet-4-5'
      }).success
    ).toBe(true)
  })

  it('salvages corrupted backupModels and activeBackup via BotSchema rollback safety', () => {
    const parsed = BotSchema.parse({
      ...sampleBot(),
      backupModels: { automatic: 'yes', order: 'invalid' },
      activeBackup: { target: { agent: 'not-real' }, switchedAt: 'never' }
    })
    expect(parsed.backupModels).toBeUndefined()
    expect(parsed.activeBackup).toBeUndefined()
  })

  it('deduplicates backups, strips entries equal to primary, and defaults automatic to true on first add', () => {
    const primary = { agent: 'claude' as const, model: 'claude-sonnet-4-5' }
    const added = addBotBackupModel(undefined, { agent: 'codex', model: 'gpt-5-codex' }, primary)
    expect(added).toEqual({
      automatic: true,
      order: [{ agent: 'codex', model: 'gpt-5-codex' }]
    })

    const normalized = normalizeBotBackupModels(
      {
        automatic: false,
        order: [
          { agent: 'claude', model: 'claude-sonnet-4-5' },
          { agent: 'codex', model: 'gpt-5-codex' },
          { agent: 'codex', model: 'gpt-5-codex' },
          { agent: 'claude', model: 'claude-haiku-4-5' }
        ]
      },
      primary
    )
    expect(normalized).toEqual({
      automatic: false,
      order: [
        { agent: 'codex', model: 'gpt-5-codex' },
        { agent: 'claude', model: 'claude-haiku-4-5' }
      ]
    })
  })

  it('reorders, removes, and remembers a manual choice at the front with automatic enabled', () => {
    const primary = { agent: 'claude' as const, model: 'claude-sonnet-4-5' }
    const initial = {
      automatic: false,
      order: [
        { agent: 'codex' as const, model: 'gpt-5-codex' },
        { agent: 'claude' as const, model: 'claude-haiku-4-5' }
      ]
    }
    expect(reorderBotBackupModels(initial, 1, 0)).toEqual({
      automatic: false,
      order: [
        { agent: 'claude', model: 'claude-haiku-4-5' },
        { agent: 'codex', model: 'gpt-5-codex' }
      ]
    })
    expect(removeBotBackupModel(initial, 0)).toEqual({
      automatic: false,
      order: [{ agent: 'claude', model: 'claude-haiku-4-5' }]
    })
    expect(removeBotBackupModel({ automatic: true, order: [initial.order[0]] }, 0)).toBeUndefined()

    expect(
      rememberedBotBackupModels({ agent: 'claude', model: 'claude-haiku-4-5' }, initial, primary)
    ).toEqual({
      automatic: true,
      order: [
        { agent: 'claude', model: 'claude-haiku-4-5' },
        { agent: 'codex', model: 'gpt-5-codex' }
      ]
    })

    const withEffort = updateBotBackupModelEffort(initial, 0, 'high')
    expect(withEffort?.order[0]).toEqual({
      agent: 'codex',
      model: 'gpt-5-codex',
      options: { effort: 'high' }
    })
    expect(updateBotBackupModelEffort(withEffort, 0, undefined)?.order[0]).toEqual({
      agent: 'codex',
      model: 'gpt-5-codex'
    })
  })

  it('preserves primary setup while resolving effectiveBotSetup and clears activeBackup when primary changes', () => {
    const bot = sampleBot({
      backupModels: {
        automatic: true,
        order: [{ agent: 'codex', model: 'gpt-5-codex' }]
      },
      activeBackup: {
        target: { agent: 'codex', model: 'gpt-5-codex' },
        switchedAt: 1_700_000_000_000,
        primaryModel: 'claude-sonnet-4-5'
      }
    })
    expect(effectiveBotSetup(bot)).toEqual({
      agent: 'codex',
      launch: { model: 'gpt-5-codex' },
      onBackup: true
    })

    const updated = applyBotUpdates(bot, { agent: 'codex', launch: { model: 'gpt-5-codex' } })
    expect(updated.activeBackup).toBeUndefined()
    // Backup matching the new primary is stripped automatically.
    expect(updated.backupModels).toBeUndefined()
  })
})
