import { describe, expect, it } from 'vitest'
import { detectLanguage } from '../../../../../shared/editor-language/editor-language-detect'
import { resolvePierreDiffLanguage } from './pierre-diff-language'

describe('resolvePierreDiffLanguage', () => {
  it.each([
    ['src/App.TSX', 'tsx'],
    ['README.MD', 'markdown'],
    ['docs/page.mdx', 'mdx'],
    ['Cargo.toml', 'toml'],
    ['force-app/Account.cls', 'apex'],
    ['nginx/site.conf', 'ini'],
    ['.env.local', 'dotenv'],
    ['.env.staging', 'dotenv'],
    ['Justfile', 'shellscript'],
    ['.zshrc', 'shellscript'],
    ['.gitignore', 'ini'],
    ['dir/CMakeLists.txt', 'cmake'],
    ['app/build.gradle', 'groovy'],
    ['Jenkinsfile.release', 'groovy'],
    ['kernels/add.cu', 'cpp'],
    ['report.qmd', 'markdown'],
    ['analysis.Rmd', 'markdown'],
    ['notebook.ipynb', 'json'],
    ['icon.svg', 'xml'],
    ['scene.excalidraw', 'json'],
    ['contracts/Token.sol', 'solidity'],
    ['rtl/top.sv', 'system-verilog'],
    ['web/index.jsp', 'html'],
    ['App.csproj', 'xml'],
    ['notes.txt', 'text'],
    ['LICENSE', 'text']
  ])('%s highlights as %s', (filePath, expected) => {
    expect(resolvePierreDiffLanguage(filePath, detectLanguage(filePath))).toBe(expected)
  })
})
