import { describe, expect, it } from 'vitest'
import {
  commandRowsToScript,
  localCommandDraftToScripts,
  scriptToCommandRows,
  type LocalCommandDraft,
  type LocalCommandRow
} from './RepositoryHooksSection'

describe('RepositoryHooksSection command row serialization', () => {
  it('round-trips blank lines and trailing whitespace in existing scripts', () => {
    const script = 'echo before  \n\ncat <<EOF\n  body  \nEOF\n'

    expect(commandRowsToScript(scriptToCommandRows(script))).toBe(script)
  })

  it('keeps persisted blank rows distinct from new empty placeholders', () => {
    const rows: LocalCommandRow[] = [
      ...scriptToCommandRows('echo before\n\n echo after  '),
      { value: '', isPlaceholder: true }
    ]

    expect(commandRowsToScript(rows)).toBe('echo before\n\n echo after  ')
  })

  it('serializes local command drafts with the same placeholder pruning used by commits', () => {
    const draft: LocalCommandDraft = {
      setup: [...scriptToCommandRows('echo setup\n'), { value: '', isPlaceholder: true }],
      archive: [
        { value: '', isPlaceholder: false },
        { value: 'echo archive', isPlaceholder: false },
        { value: '', isPlaceholder: true }
      ]
    }

    expect(localCommandDraftToScripts(draft)).toEqual({
      setup: 'echo setup\n',
      archive: '\necho archive'
    })
  })
})
