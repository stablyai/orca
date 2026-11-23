export const BOTS_SETTINGS_SECTION_ID = 'bots'

const BOT_SECTION_PREFIX = 'bot-'

export function botSettingsSectionId(botId: string): string {
  return `${BOT_SECTION_PREFIX}${botId}`
}

export function botIdFromSettingsSectionId(sectionId: string): string | null {
  return sectionId.startsWith(BOT_SECTION_PREFIX)
    ? sectionId.slice(BOT_SECTION_PREFIX.length)
    : null
}

/** Bots and each bot's page act on every computer at once, so they take no computer picker. */
export function isBotsSettingsSection(sectionId: string): boolean {
  return sectionId === BOTS_SETTINGS_SECTION_ID || botIdFromSettingsSectionId(sectionId) !== null
}

/** Where a bot's section id opens Settings: its page under Bots; null for any other section. */
export function botSettingsTargetFromSectionId(
  sectionId: string
): { pane: 'bots'; repoId: null; sectionId: string } | null {
  const botId = botIdFromSettingsSectionId(sectionId)
  return botId === null ? null : { pane: 'bots', repoId: null, sectionId: botId }
}
