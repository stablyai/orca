import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { i18n } from '@/i18n/i18n'
import russian from '@/i18n/test-resources/runtime-source-grammar.json'
import { reportTerminalDropUploadSkipsAndFailures } from './terminal-drop-upload-report'

vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))

beforeEach(async () => {
  vi.clearAllMocks()
  i18n.addResourceBundle('ru', 'translation', russian, true, true)
  await i18n.changeLanguage('ru')
})

afterEach(async () => {
  await i18n.changeLanguage('en')
})

describe('terminal drop reports', () => {
  it('stays silent when nothing was skipped or failed', () => {
    reportTerminalDropUploadSkipsAndFailures([], [])
    expect(toast.message).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it.each([
    [1, 'Пропущена 1 символьная ссылка.', 'Пропущен 1 элемент.', 'Не удалось загрузить 1 файл.'],
    [2, 'Пропущены 2 символьные ссылки.', 'Пропущено 2 элемента.', 'Не удалось загрузить 2 файла.'],
    [
      5,
      'Пропущено 5 символьных ссылок.',
      'Пропущено 5 элементов.',
      'Не удалось загрузить 5 файлов.'
    ],
    [21, 'Пропущена 21 символьная ссылка.', 'Пропущен 21 элемент.', 'Не удалось загрузить 21 файл.']
  ] as const)('inflects all upload reports for %i items', (count, symlinks, items, failures) => {
    reportTerminalDropUploadSkipsAndFailures(
      Array.from({ length: count }, () => ({ reason: 'symlink' })),
      []
    )
    expect(toast.message).toHaveBeenLastCalledWith(symlinks, { description: undefined })
    reportTerminalDropUploadSkipsAndFailures(
      Array.from({ length: count }, () => ({ reason: 'permission-denied' })),
      []
    )
    expect(toast.message).toHaveBeenLastCalledWith(items, { description: expect.any(String) })
    reportTerminalDropUploadSkipsAndFailures(
      [],
      Array.from({ length: count }, () => ({ reason: '/secret/project/file.txt' }))
    )
    expect(toast.error).toHaveBeenLastCalledWith(failures)
    expect(toast.error).toHaveBeenCalledWith(
      expect.not.stringContaining('/secret/project/file.txt')
    )
  })

  it('keeps mixed and unknown reasons generic', () => {
    reportTerminalDropUploadSkipsAndFailures([{ reason: 'missing' }, { reason: 'symlink' }], [])
    reportTerminalDropUploadSkipsAndFailures([{ reason: 'too_large' }], [])
    expect(vi.mocked(toast.message).mock.calls.map((call) => call[1])).toEqual([
      { description: undefined },
      { description: undefined }
    ])
  })

  it('keeps singular and plural English defaults usable before catalog generation', async () => {
    await i18n.changeLanguage('en')
    reportTerminalDropUploadSkipsAndFailures(
      [{ reason: 'symlink' }],
      [{ reason: 'unknown' }, { reason: 'unknown' }]
    )
    expect(toast.message).toHaveBeenCalledWith('Skipped 1 symlink.', { description: undefined })
    expect(toast.error).toHaveBeenCalledWith('Failed to upload 2 files.')
  })
})
