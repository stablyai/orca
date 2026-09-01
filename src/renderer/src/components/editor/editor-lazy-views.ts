import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'

// Why: one lazy() identity per viewer, shared by every editor surface — a second lazy() over the
// same module is a distinct component type, so it gets its own Suspense boundary and remount.
export const MonacoEditor = lazy(() => import('./MonacoEditor'))
export const DiffViewer = lazy(() => import('./DiffViewer'))
export const CombinedDiffViewer = lazy(() => import('./combined-diff/CombinedDiffViewer'))
export const RichMarkdownEditor = lazy(() => import('./RichMarkdownEditor'), {
  reloadKey: 'rich-markdown-editor'
})
export const MarkdownPreview = lazy(() => import('./MarkdownPreview'))
export const ImageViewer = lazy(() => import('./ImageViewer'))
export const ImageDiffViewer = lazy(() => import('./ImageDiffViewer'))
export const MermaidViewer = lazy(() => import('./MermaidViewer'))
export const CsvViewer = lazy(() => import('./CsvViewer'))
export const IpynbViewer = lazy(() => import('./IpynbViewer'))
