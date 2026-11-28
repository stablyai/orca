import { expect, it } from 'vitest'
import { parseIpynb } from './ipynb-parse'

it('joins notebook text fragments without inventing line breaks and keeps traceback frames apart', () => {
  const notebook = parseIpynb(
    JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          source: ["value = 'hel", "lo'\r", '\nprint(value)'],
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['hel', 'lo\r', '\n'] },
            { output_type: 'error', ename: 'Error', evalue: 'failed', traceback: ['first', 'last'] }
          ]
        }
      ]
    })
  )

  expect(notebook.cells[0]?.source).toBe("value = 'hello'\nprint(value)")
  expect(notebook.cells[0]?.outputs).toEqual([
    { kind: 'stream', name: 'stdout', text: 'hello\n' },
    { kind: 'error', name: 'Error', message: 'failed', traceback: 'first\nlast' }
  ])
})
