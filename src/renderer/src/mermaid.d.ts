declare module 'mermaid' {
  type MermaidTheme = 'default' | 'dark' | 'base'

  type MermaidInitializeOptions = {
    startOnLoad?: boolean
    theme?: MermaidTheme
    darkMode?: boolean
    themeVariables?: Record<string, string | boolean>
    htmlLabels?: boolean
    securityLevel?: 'strict' | 'loose' | 'antiscript' | 'sandbox'
    suppressErrorRendering?: boolean
  }

  type MermaidRenderResult = {
    svg: string
    bindFunctions?: (element: Element) => void
  }

  type MermaidApi = {
    initialize: (options: MermaidInitializeOptions) => void
    mermaidAPI: { getConfig: () => MermaidInitializeOptions }
    render: (id: string, text: string) => Promise<MermaidRenderResult>
  }

  const mermaid: MermaidApi
  export default mermaid
}
