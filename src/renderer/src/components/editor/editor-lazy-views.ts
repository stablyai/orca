import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'

// Share lazy component identities across surfaces; a second lazy wrapper over the same module causes separate boundaries and remounts.
export const MonacoEditor = lazy(() => import('./monaco/MonacoEditor'))
export const DiffViewer = lazy(() => import('./diff/monaco-view/DiffViewer'))
export const CombinedDiffViewer = lazy(() => import('./combined-diff/CombinedDiffViewer'))
export const RichMarkdownEditor = lazy(
  () => import('./rich-markdown/instance/RichMarkdownEditor'),
  {
    reloadKey: 'rich-markdown-editor'
  }
)
export const MarkdownPreview = lazy(() => import('./markdown-preview/surface/MarkdownPreview'))
export const ImageViewer = lazy(() => import('./document-images/ImageViewer'))
export const MediaViewer = lazy(() => import('./document-media/MediaViewer'))
export const ImageDiffViewer = lazy(() => import('./diff/large-files/ImageDiffViewer'))
export const MermaidViewer = lazy(() => import('./diagrams/MermaidViewer'))
export const CsvViewer = lazy(() => import('./csv/CsvViewer'))
export const CsvPagedViewer = lazy(() => import('./csv/preview/CsvPagedViewer'))
export const IpynbViewer = lazy(() => import('./notebook/document/IpynbViewer'))
