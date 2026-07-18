import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import es from './locales/es.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import zh from './locales/zh.json'

const englishPreflightAuthCopy = [
  en.auto.components.Landing.github_cli_auth_check_failed,
  en.auto.components.Landing.github_cli_auth_check_failed_description,
  en.auto.components.Landing.github_cli_auth_check_error,
  en.auto.components.Landing.github_cli_auth_check_error_description,
  en.auto.components.Landing.github_cli_auth_check_error_fix_label,
  en.auto.components.settings.cli.source.control.integration.cards.connection_error,
  en.auto.components.settings.cli.source.control.integration.cards.cli_error,
  en.auto.components.settings.cli.source.control.integration.cards.github_auth_check_failed,
  en.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_failed,
  en.auto.components.settings.cli.source.control.integration.cards.github_auth_check_error,
  en.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_error
]

const localizedPreflightAuthCopy = [
  [
    es.auto.components.Landing.github_cli_auth_check_failed,
    es.auto.components.Landing.github_cli_auth_check_failed_description,
    es.auto.components.Landing.github_cli_auth_check_error,
    es.auto.components.Landing.github_cli_auth_check_error_description,
    es.auto.components.Landing.github_cli_auth_check_error_fix_label,
    es.auto.components.settings.cli.source.control.integration.cards.connection_error,
    es.auto.components.settings.cli.source.control.integration.cards.cli_error,
    es.auto.components.settings.cli.source.control.integration.cards.github_auth_check_failed,
    es.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_failed,
    es.auto.components.settings.cli.source.control.integration.cards.github_auth_check_error,
    es.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_error
  ],
  [
    ja.auto.components.Landing.github_cli_auth_check_failed,
    ja.auto.components.Landing.github_cli_auth_check_failed_description,
    ja.auto.components.Landing.github_cli_auth_check_error,
    ja.auto.components.Landing.github_cli_auth_check_error_description,
    ja.auto.components.Landing.github_cli_auth_check_error_fix_label,
    ja.auto.components.settings.cli.source.control.integration.cards.connection_error,
    ja.auto.components.settings.cli.source.control.integration.cards.cli_error,
    ja.auto.components.settings.cli.source.control.integration.cards.github_auth_check_failed,
    ja.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_failed,
    ja.auto.components.settings.cli.source.control.integration.cards.github_auth_check_error,
    ja.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_error
  ],
  [
    ko.auto.components.Landing.github_cli_auth_check_failed,
    ko.auto.components.Landing.github_cli_auth_check_failed_description,
    ko.auto.components.Landing.github_cli_auth_check_error,
    ko.auto.components.Landing.github_cli_auth_check_error_description,
    ko.auto.components.Landing.github_cli_auth_check_error_fix_label,
    ko.auto.components.settings.cli.source.control.integration.cards.connection_error,
    ko.auto.components.settings.cli.source.control.integration.cards.cli_error,
    ko.auto.components.settings.cli.source.control.integration.cards.github_auth_check_failed,
    ko.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_failed,
    ko.auto.components.settings.cli.source.control.integration.cards.github_auth_check_error,
    ko.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_error
  ],
  [
    zh.auto.components.Landing.github_cli_auth_check_failed,
    zh.auto.components.Landing.github_cli_auth_check_failed_description,
    zh.auto.components.Landing.github_cli_auth_check_error,
    zh.auto.components.Landing.github_cli_auth_check_error_description,
    zh.auto.components.Landing.github_cli_auth_check_error_fix_label,
    zh.auto.components.settings.cli.source.control.integration.cards.connection_error,
    zh.auto.components.settings.cli.source.control.integration.cards.cli_error,
    zh.auto.components.settings.cli.source.control.integration.cards.github_auth_check_failed,
    zh.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_failed,
    zh.auto.components.settings.cli.source.control.integration.cards.github_auth_check_error,
    zh.auto.components.settings.cli.source.control.integration.cards.gitlab_auth_check_error
  ]
]

describe('preflight CLI authentication translations', () => {
  it('does not ship English fallback copy in non-English locales', () => {
    for (const localizedCopy of localizedPreflightAuthCopy) {
      localizedCopy.forEach((value, index) => {
        expect(value).not.toBe(englishPreflightAuthCopy[index])
      })
    }
  })
})
