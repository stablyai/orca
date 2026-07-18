import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

/**
 * Select the authentication copy that every locale must translate independently.
 *
 * @param locale Locale catalog with the English catalog shape.
 * @returns Authentication-related landing and integration-card messages.
 */
function getPreflightAuthCopy(locale: typeof en): string[] {
  return [
    locale.auto.components.Landing.github_cli_auth_check_failed,
    locale.auto.components.Landing.github_cli_auth_check_failed_description,
    locale.auto.components.Landing.github_cli_auth_check_error,
    locale.auto.components.Landing.github_cli_auth_check_error_description,
    locale.auto.components.Landing.github_cli_auth_check_error_fix_label,
    locale.auto.components.settings.cli.source.control.integration.cards.connection_error,
    locale.auto.components.settings.cli.source.control.integration.cards.cli_error,
    locale.auto.components.settings.cli.source.control.integration.cards.github_auth_check_failed,
    locale.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_failed,
    locale.auto.components.settings.cli.source.control.integration.cards.github_auth_check_error,
    locale.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_error
  ]
}

const englishPreflightAuthCopy = getPreflightAuthCopy(en)
const localizedPreflightAuthCopy = [es, ja, ko, zh].map(getPreflightAuthCopy)

describe('preflight CLI authentication translations', () => {
  it('does not ship English fallback copy in non-English locales', () => {
    for (const localizedCopy of localizedPreflightAuthCopy) {
      localizedCopy.forEach((value, index) => {
        expect(value).not.toBe(englishPreflightAuthCopy[index])
      })
    }
  })
})
