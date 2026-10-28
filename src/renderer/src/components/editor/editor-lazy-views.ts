import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'

// Share lazy component identities across surfaces; a second lazy wrapper over the same module causes separate boundaries and remounts.
export const MonacoEditor = lazy(() => import('./MonacoEditor'))
export const DiffViewer = lazy(() => import('./DiffViewer'))
export const CombinedDiffViewer = lazy(() => import('./combined-diff/CombinedDiffViewer'))
export const RichMarkdownEditor = lazy(() => import('./RichMarkdownEditor'), {
  reloadKey: 'rich-markdown-editor'
})
export const MarkdownPreview = lazy(() => import('./MarkdownPreview'))
export const ImageViewer = lazy(() => import('./ImageViewer'))
export const MediaViewer = lazy(() => import('./MediaViewer'))
export const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'))
export const MermaidViewer = lazy(() => import('./MermaidViewer'))
export const CsvViewer = lazy(() => import('./csv/CsvViewer'))
export const CsvPagedViewer = lazy(() => import('./csv/CsvPagedViewer'))
export const IpynbViewer = lazy(() => import('./IpynbViewer'))
