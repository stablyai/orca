/** Renderer → main: an extension context calls `chrome.<namespace>.<method>(...args)`. */
export const BROWSER_EXTENSION_CALL_CHANNEL = 'orca-browser-extension:call'
/** Main → extension context: an event fires as `(key, args)`, key being "namespace.event". */
export const BROWSER_EXTENSION_EVENT_CHANNEL = 'orca-browser-extension:event'
