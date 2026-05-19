// Ambient declarations for Vite/rollup `?raw` imports. The `?raw` query
// inlines a file's UTF-8 contents as a string at bundle time, so the module
// resolves to `string` rather than the file's own shape. Used by the main
// process to embed small HTML modals without copying static assets into the
// asar archive.

declare module '*?raw' {
  const content: string
  export default content
}
