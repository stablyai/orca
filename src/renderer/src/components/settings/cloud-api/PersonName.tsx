import { Trans } from 'react-i18next'
import { i18n } from '@/i18n/i18n'

/**
 * A teammate as the control plane knows them: "Ada Lovelace · u_ada" (name, then the id as
 * secondary text), or the id alone when no name is known. Never a vague "a teammate".
 */
export function PersonName({
  name,
  id
}: {
  name: string | null | undefined
  id: string
}): React.JSX.Element {
  const display = name?.trim()
  if (!display) {
    return (
      <span className="font-mono text-[0.95em]" title={id}>
        {id}
      </span>
    )
  }
  return (
    <span title={`${display} · ${id}`}>
      <span className="text-foreground">{display}</span>
      <span className="text-muted-foreground">
        {' · '}
        <span className="font-mono text-[0.95em]">{id}</span>
      </span>
    </span>
  )
}

/**
 * A translated sentence with the person rendered in place of `<person></person>`, so word order
 * stays in the translation (no concatenation). `sentence` is the already-translated default.
 */
export function PersonSentence({
  sentence,
  name,
  id
}: {
  sentence: string
  name: string | null | undefined
  id: string
}): React.JSX.Element {
  return (
    <Trans
      i18n={i18n}
      defaults={sentence}
      components={{ person: <PersonName name={name} id={id} /> }}
    />
  )
}
