// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { i18n } from '@/i18n/i18n'
import { IpynbCellRunOutputs } from './IpynbCellRun'
import type { IpynbCell } from './ipynb-parse'

vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => false }))

const cell: IpynbCell = {
  id: 'cell-1',
  kind: 'code',
  language: 'python',
  source: 'df',
  executionCount: 1,
  outputs: [
    {
      kind: 'display',
      outputType: 'display_data',
      executionCount: null,
      items: [{ mime: 'text/html', value: '<table></table>' }]
    }
  ]
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
})

describe('memoized notebook cell outputs', () => {
  it('relabels HTML output when the UI language changes without new props', async () => {
    await i18n.changeLanguage('en')
    render(<IpynbCellRunOutputs filePath="/nb.ipynb" cellKey="cell-1" cell={cell} />)
    expect(screen.getByTitle('Notebook HTML output')).toBeTruthy()

    await i18n.changeLanguage('es')
    expect(await screen.findByTitle('Salida HTML del notebook')).toBeTruthy()
  })
})
