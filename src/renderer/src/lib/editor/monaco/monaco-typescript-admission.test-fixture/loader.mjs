export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context)
  if (resolved.url.endsWith('/monaco-editor/esm/vs/common/workers.js')) {
    return { url: new URL('./transport.mjs', import.meta.url).href, shortCircuit: true }
  }
  return resolved
}

export async function load(url, context, nextLoad) {
  if (url.endsWith('.css')) {
    return { format: 'module', source: 'export default {}', shortCircuit: true }
  }
  return nextLoad(url, context)
}
