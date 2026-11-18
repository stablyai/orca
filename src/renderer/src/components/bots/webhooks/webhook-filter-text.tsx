// "level is error or fatal, and project is web": a hook's filters in words, payload paths set as code.
import React from 'react'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { WebhookFilters, WebhookWhere } from '../../../../../shared/connector-webhook-contract'

function PathCode({ path }: { path: string }): React.JSX.Element {
  return (
    <code className="rounded bg-muted px-1 py-0.5 font-mono text-2xs whitespace-nowrap text-foreground">
      {path}
    </code>
  )
}

function anyOf(values: readonly string[]): string {
  return new Intl.ListFormat(getIntlLocale(), { type: 'disjunction' }).format(values)
}

function whereWords(where: WebhookWhere): string {
  const values = anyOf(where.values ?? [])
  switch (where.op) {
    case '=':
    case 'in':
      return translate('bots.webhooks.where.is', 'is {{values}}', { values })
    case '!=':
      return translate('bots.webhooks.where.isNot', 'isn’t {{values}}', { values })
    case 'contains':
      return translate('bots.webhooks.where.contains', 'contains {{values}}', { values })
    case 'exists':
      return translate('bots.webhooks.where.exists', 'is present')
    case '!exists':
      return translate('bots.webhooks.where.missing', 'is missing')
  }
}

/** False when the hook takes every call. */
export function hasWebhookFilters(filters: WebhookFilters): boolean {
  return (
    (filters.where?.length ?? 0) > 0 || Boolean(filters.textContains) || Boolean(filters.subject)
  )
}

export function WebhookOnlyWhen({
  filters
}: {
  filters: WebhookFilters
}): React.JSX.Element | null {
  const t = useTranslate()
  // A rule's clauses are unique by what they test, so that names each one.
  const clauses: { key: string; node: React.ReactNode }[] = (filters.where ?? []).map((where) => ({
    key: `where:${where.path}:${where.op}:${(where.values ?? []).join(',')}`,
    node: (
      <>
        <PathCode path={where.path} /> {whereWords(where)}
      </>
    )
  }))
  if (filters.textContains) {
    clauses.push({
      key: 'text',
      node: t('bots.webhooks.where.text', 'the body contains “{{text}}”', {
        text: filters.textContains
      })
    })
  }
  if (filters.subject) {
    clauses.push({
      key: 'subject',
      node: t('bots.webhooks.where.subject', 'it’s about {{subject}}', {
        subject: filters.subject
      })
    })
  }
  if (clauses.length === 0) {
    return null
  }
  const and = t('bots.webhooks.where.and', ', and ')
  return (
    <>
      {clauses.map((clause, index) => (
        <React.Fragment key={clause.key}>
          {index > 0 ? and : null}
          {clause.node}
        </React.Fragment>
      ))}
    </>
  )
}

/** The payload fields quoted to the run, or null when it gets the full body file only. */
export function WebhookQuotes({
  pick
}: {
  pick: readonly string[] | undefined
}): React.JSX.Element | null {
  if (!pick || pick.length === 0) {
    return null
  }
  return (
    <>
      {pick.map((path, index) => (
        <React.Fragment key={path}>
          {index > 0 ? ', ' : null}
          <PathCode path={path} />
        </React.Fragment>
      ))}
    </>
  )
}
