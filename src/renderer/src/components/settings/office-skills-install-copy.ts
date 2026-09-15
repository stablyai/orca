import { translate } from '@/i18n/i18n'

/**
 * What the skills action reports after it runs.
 *
 * The caller picks the plural key rather than leaving it to i18next, matching
 * `connectedHostCountLabel`: `translate(key, fallback)` resolves the inline fallback for `en`, so
 * a single key carrying `{{count}}` would render "Installed 1 skills" however the catalog is
 * written.
 */
export function officeSkillsInstalledMessage(installed: number): string {
  return installed === 1
    ? translate(
        'auto.components.settings.officeSkills.installed_one',
        'Installed {{count}} skill.',
        {
          count: installed
        }
      )
    : translate(
        'auto.components.settings.officeSkills.installed_other',
        'Installed {{count}} skills.',
        { count: installed }
      )
}

/**
 * The partial case names the noun and both numbers. The previous wording — "Installed 1; 1 could
 * not be installed." — dropped the noun entirely and read as a counter with nothing counted.
 */
export function officeSkillsPartialMessage(installed: number, failed: number): string {
  const total = installed + failed
  return total === 1
    ? translate(
        'auto.components.settings.officeSkills.installedPartial_one',
        'Installed {{installed}} of {{count}} skill.',
        { installed, count: total }
      )
    : translate(
        'auto.components.settings.officeSkills.installedPartial_other',
        'Installed {{installed}} of {{count}} skills.',
        { installed, count: total }
      )
}
