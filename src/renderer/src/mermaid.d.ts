declare module 'mermaid' {
  type MermaidTheme = 'default' | 'dark'

  type MermaidInitializeOptions = {
    startOnLoad?: boolean
    theme?: MermaidTheme
  }

  type MermaidRenderResult = {
    svg: string
    bindFunctions?: (element: Element) => void
  }

  type MermaidApi = {
    initialize: (options: MermaidInitializeOptions) => void
    render: (id: string, text: string) => Promise<MermaidRenderResult>
  }

  const mermaid: MermaidApi
  export default mermaid
}
