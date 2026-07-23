declare module 'mermaid' {
  type MermaidTheme = 'default' | 'dark'

  type MermaidInitializeOptions = {
    startOnLoad?: boolean
    theme?: MermaidTheme
    htmlLabels?: boolean
    securityLevel?: 'strict' | 'loose' | 'antiscript' | 'sandbox'
    suppressErrorRendering?: boolean
    secure?: string[]
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
