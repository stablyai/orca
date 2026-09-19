import { describe, expect, it } from 'vitest'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import {
  extractHtmlUrlFromDataTransfer,
  isHtmlOrWebUrlDrag,
  isHtmlPathString
} from './browser-html-drag-resolver'

describe('browser-html-drag-resolver', () => {
  describe('isHtmlPathString', () => {
    it('recognizes html and htm file extensions', () => {
      expect(isHtmlPathString('index.html')).toBe(true)
      expect(isHtmlPathString('demo.HTM')).toBe(true)
      expect(isHtmlPathString('/path/to/app.html')).toBe(true)
      expect(isHtmlPathString('index.html?slide=4')).toBe(true)
      expect(isHtmlPathString('index.html#top')).toBe(true)
    })

    it('rejects non-html files and arbitrary text', () => {
      expect(isHtmlPathString('script.js')).toBe(false)
      expect(isHtmlPathString('style.css')).toBe(false)
      expect(isHtmlPathString('hello world')).toBe(false)
      expect(isHtmlPathString('')).toBe(false)
    })
  })

  describe('isHtmlOrWebUrlDrag', () => {
    it('returns true when text/plain or Files is present', () => {
      expect(isHtmlOrWebUrlDrag({ types: ['text/plain'] })).toBe(true)
      expect(isHtmlOrWebUrlDrag({ types: ['Files'] })).toBe(true)
      expect(isHtmlOrWebUrlDrag({ types: [WORKSPACE_FILE_PATH_MIME] })).toBe(true)
      expect(isHtmlOrWebUrlDrag({ types: ['text/uri-list'] })).toBe(true)
    })

    it('returns false for unrelated drag types', () => {
      expect(isHtmlOrWebUrlDrag({ types: ['application/x-other'] })).toBe(false)
      expect(isHtmlOrWebUrlDrag({ types: [] })).toBe(false)
    })
  })

  describe('extractHtmlUrlFromDataTransfer', () => {
    it('extracts terminal selected text like index.html and resolves with worktree path', () => {
      const mockTransfer = {
        types: ['text/plain'],
        getData: (type: string) => (type === 'text/plain' ? 'index.html' : '')
      }

      const result = extractHtmlUrlFromDataTransfer(mockTransfer, '/workspace/my-app')
      expect(result).not.toBeNull()
      expect(result?.url).toBe('file:///workspace/my-app/index.html')
      expect(result?.title).toBe('index.html')
      expect(result?.sourceKind).toBe('text-selection')
    })

    it('sanitizes punctuation around terminal file links e.g. "index.html,"', () => {
      const mockTransfer = {
        types: ['text/plain'],
        getData: (type: string) => (type === 'text/plain' ? 'index.html,' : '')
      }

      const result = extractHtmlUrlFromDataTransfer(mockTransfer, '/workspace/my-app')
      expect(result).not.toBeNull()
      expect(result?.url).toBe('file:///workspace/my-app/index.html')
      expect(result?.title).toBe('index.html')
    })

    it('extracts absolute paths without needing worktree prefix', () => {
      const mockTransfer = {
        types: ['text/plain'],
        getData: (type: string) => (type === 'text/plain' ? '/Users/test/dist/index.html' : '')
      }

      const result = extractHtmlUrlFromDataTransfer(mockTransfer, '/other/path')
      expect(result).not.toBeNull()
      expect(result?.url).toBe('file:///Users/test/dist/index.html')
      expect(result?.title).toBe('index.html')
    })

    it('extracts native dropped files with path property', () => {
      const mockFile = {
        name: 'report.html',
        path: '/tmp/build/report.html'
      }
      const mockTransfer = {
        types: ['Files'],
        files: [mockFile] as unknown as FileList,
        getData: () => ''
      }

      const result = extractHtmlUrlFromDataTransfer(mockTransfer)
      expect(result).not.toBeNull()
      expect(result?.url).toBe('file:///tmp/build/report.html')
      expect(result?.title).toBe('report.html')
      expect(result?.sourceKind).toBe('native-file')
    })

    it('extracts uri-list file URLs', () => {
      const mockTransfer = {
        types: ['text/uri-list'],
        getData: (type: string) => (type === 'text/uri-list' ? 'file:///tmp/index.html\r\n' : '')
      }

      const result = extractHtmlUrlFromDataTransfer(mockTransfer)
      expect(result).not.toBeNull()
      expect(result?.url).toBe('file:///tmp/index.html')
      expect(result?.sourceKind).toBe('uri-list')
    })

    it('returns null for non-html text', () => {
      const mockTransfer = {
        types: ['text/plain'],
        getData: () => 'some random terminal log message'
      }

      const result = extractHtmlUrlFromDataTransfer(mockTransfer, '/workspace')
      expect(result).toBeNull()
    })
  })
})
