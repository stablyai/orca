// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpynbCellOutputs } from '../outputs/IpynbCellOutputs'

import type { IpynbCell, IpynbOutput } from './ipynb-parse'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/hooks/use-document-dark-theme', () => ({ useDocumentDarkTheme: () => true }))
vi.mock('@/lib/editor/monaco/monaco-setup', () => ({ monaco: {} }))
vi.mock('../../MonacoCodeExcerpt', () => ({
  useMonacoColorizedLines: () => []
}))

function cell(kind: IpynbCell['kind'], source: string, outputs: IpynbOutput[] = []): IpynbCell {
  return { id: 'cell-1', kind, language: 'python', source, executionCount: 1, outputs }
}

afterEach(cleanup)

describe('notebook outputs', () => {
  it('sandboxes HTML output behind a no-network CSP and strips scripts', () => {
    render(
      <IpynbCellOutputs
        cell={cell('code', 'html', [
          {
            kind: 'display',
            outputType: 'display_data',
            executionCount: null,
            items: [{ mime: 'text/html', value: '<script>alert(1)</script><b>safe</b>' }]
          }
        ])}
      />
    )
    const frame = screen.getByTitle('Notebook HTML output')
    const source = frame.getAttribute('srcdoc') ?? ''
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(source).toContain("default-src 'none'; img-src data:")
    expect(source).not.toContain('<script')
    expect(source).toContain('<b>safe</b>')
  })
})
