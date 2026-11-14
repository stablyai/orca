import { GitFork } from 'lucide-react'
import { Fragment } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import {
  FORK_MARKED_NAME_SLOTS,
  forkMarkedNameParts
} from '../../../../../shared/agent-session/agent-session-fork-name-order'

/** A forked chat's name with its "Fork ·" mark, in the locale's order. Under a named `tab`
 *  container narrower than 180px the word gives way to the fork icon; screen readers hear
 *  "Fork: <name>" at every width. */
export function ForkMarkedName({ name }: { name: string }): React.JSX.Element {
  const t = useTranslate()
  const parts = forkMarkedNameParts(
    t('components.native-chat.fork.markedName', '{{mark}} {{name}}', {
      ...FORK_MARKED_NAME_SLOTS,
      interpolation: { escapeValue: false }
    })
  )
  return (
    <>
      <span className="sr-only">
        {t('components.native-chat.fork.accessibleName', 'Fork: {{name}}', {
          name,
          interpolation: { escapeValue: false }
        })}
      </span>
      <span aria-hidden>
        {parts.map((part) => (
          <Fragment key={part.key}>
            {part.kind === 'mark' ? (
              <span className="opacity-60">
                <span className="@max-[180px]/tab:hidden">
                  {t('components.native-chat.fork.mark', 'Fork ·')}
                </span>
                <GitFork className="hidden size-3.5 align-[-3px] @max-[180px]/tab:inline-block" />
              </span>
            ) : part.kind === 'name' ? (
              name
            ) : (
              part.text
            )}
          </Fragment>
        ))}
      </span>
    </>
  )
}
