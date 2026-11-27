// A linked event's refs as Activity shows them: the URL or path itself, without the `url:` or `file:`
// kind its event stores, with a line break offered after each `/` of a path and before a query's `?`,
// `&` or `#`, so a long ref wraps between its parts rather than mid-word.
import { Fragment } from 'react'

const SHOWN_WITHOUT_KIND = /^(?:url|file):/
// After a slash that ends a path part (never in `https://` or after a leading `/`), or before a query part.
const BREAKS = /(?<=[^\s:/]\/)|(?=[?&#])/

/** A ref's parts, each with where it starts in the ref (its stable key). */
function partsOf(ref: string): { part: string; at: number }[] {
  let at = 0
  return ref.split(BREAKS).map((part) => {
    const start = at
    at += part.length
    return { part, at: start }
  })
}

export function BotItemLinkedRefs({ links }: { links: readonly string[] }): React.JSX.Element {
  return (
    <>
      {links.map((link) => (
        // A ref is linked once per event, so its words key it.
        <Fragment key={link}>
          {link === links[0] ? null : ', '}
          {partsOf(link.replace(SHOWN_WITHOUT_KIND, '')).map(({ part, at }) => (
            <Fragment key={at}>
              {at > 0 ? <wbr /> : null}
              {part}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </>
  )
}
